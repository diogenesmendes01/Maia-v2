/**
 * P06 (spec §9.2, §6.10; gate G-COST; T56, T57, T58, T59) — a CONTABILIDADE e a
 * RESERVA como políticas PURAS.
 *
 * Dois módulos, duas perguntas opostas:
 *
 *  - `cost-accounting.ts` — "quanto ISTO custou, e o quanto disso eu SEI?".
 *    Uma dobra sobre eventos de uso, idempotente por `event_id`;
 *  - `cost-reservation.ts` — "posso admitir mais uma tentativa?". A decisão de
 *    admissão sob limite, que o §9.2 descreve como reserva atômica.
 *
 * O que estes casos cobram, e que nenhum compilador cobra:
 *
 *   1. T57 — evento repetido não soma duas vezes, e evento repetido com valor
 *      DIFERENTE não sobrescreve em silêncio (§9.2: "nenhum overwrite
 *      silencioso de custo anterior");
 *   2. T59 — `estimated`/`unknown` são estados VISÍVEIS. Zero sem evidência
 *      nunca é `settled`: "`cost=null` não é zero" (§9.2);
 *   3. T56 — falha de provider com possível cobrança não zera custo. A
 *      exposição estimada sobrevive à falha, e evidência nova AJUSTA com evento
 *      compensatório em vez de apagar a cobrança original;
 *   4. T58 — admissões simultâneas nunca ultrapassam o limite, e a decisão
 *      DIZ que é controle de admissão, não hard cap real;
 *   5. dinheiro é inteiro em `microusd` (§5.3.1/§9.2), nunca float — inclusive
 *      acima de `Number.MAX_SAFE_INTEGER`;
 *   6. os dois módulos são PUROS — verificado lendo o fonte como TEXTO.
 *
 * Puro: nenhum caso toca banco, Redis ou provider. Nenhuma chamada paga.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  USAGE_EVENT_KINDS,
  ACCOUNTING_STATUSES,
  UsageEventConflictError,
  foldUsageEvents,
  type UsageEventV1,
} from '@/integrations/hermes/cost-accounting.js';
import {
  ADMISSION_GUARANTEE,
  decideAdmission,
  applyAdmission,
  type BudgetAccountV1,
} from '@/integrations/hermes/cost-reservation.js';

const raiz = resolve(__dirname, '../..');
const fonteAccounting = readFileSync(
  resolve(raiz, 'src/integrations/hermes/cost-accounting.ts'),
  'utf8',
);
const fonteReservation = readFileSync(
  resolve(raiz, 'src/integrations/hermes/cost-reservation.ts'),
  'utf8',
);

function ev(over: Partial<UsageEventV1> & { event_id: string }): UsageEventV1 {
  return {
    attempt_id: 'attempt-1',
    kind: 'reported',
    delta_microusd: '1000',
    source: 'provider_accounted',
    ...over,
  };
}

function conta(over: Partial<BudgetAccountV1> = {}): BudgetAccountV1 {
  return {
    limit_microusd: '100000',
    reserved_microusd: '0',
    settled_microusd: '0',
    row_version: 1,
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// T57 — idempotência
// ───────────────────────────────────────────────────────────────────────────

describe('T57 — evento de uso repetido não soma duas vezes', () => {
  it('1. o mesmo `event_id` entregue duas vezes conta UMA', () => {
    const r = foldUsageEvents([ev({ event_id: 'e1' }), ev({ event_id: 'e1' })]);
    expect(r.total_microusd).toBe('1000');
    expect(r.duplicates_ignored).toBe(1);
    expect(r.counted_event_ids).toEqual(['e1']);
  });

  it('2. ids distintos somam', () => {
    const r = foldUsageEvents([ev({ event_id: 'e1' }), ev({ event_id: 'e2' })]);
    expect(r.total_microusd).toBe('2000');
    expect(r.duplicates_ignored).toBe(0);
  });

  it('3. redelivery em qualquer ORDEM dá o mesmo total (a dobra é comutativa)', () => {
    const eventos = [
      ev({ event_id: 'e1', delta_microusd: '700' }),
      ev({ event_id: 'e2', delta_microusd: '300' }),
      ev({ event_id: 'e1', delta_microusd: '700' }),
    ];
    const direta = foldUsageEvents(eventos);
    const invertida = foldUsageEvents([...eventos].reverse());
    expect(direta.total_microusd).toBe(invertida.total_microusd);
    expect(direta.total_microusd).toBe('1000');
  });

  it('4. poll repetido N vezes é estável (idempotência de verdade, não de uma vez)', () => {
    const um = foldUsageEvents([ev({ event_id: 'e1' })]);
    const dez = foldUsageEvents(Array.from({ length: 10 }, () => ev({ event_id: 'e1' })));
    expect(dez.total_microusd).toBe(um.total_microusd);
    expect(dez.duplicates_ignored).toBe(9);
  });

  it('5. mesmo id com valor DIFERENTE é conflito, nunca overwrite silencioso', () => {
    expect(() =>
      foldUsageEvents([
        ev({ event_id: 'e1', delta_microusd: '1000' }),
        ev({ event_id: 'e1', delta_microusd: '9999' }),
      ]),
    ).toThrow(UsageEventConflictError);
  });

  it('6. mesmo id com KIND diferente também é conflito', () => {
    expect(() =>
      foldUsageEvents([
        ev({ event_id: 'e1', kind: 'reported' }),
        ev({ event_id: 'e1', kind: 'estimated' }),
      ]),
    ).toThrow(UsageEventConflictError);
  });

  it('7. o conflito nomeia o evento, e não despeja o valor', () => {
    try {
      foldUsageEvents([
        ev({ event_id: 'e1', delta_microusd: '1000' }),
        ev({ event_id: 'e1', delta_microusd: '9999' }),
      ]);
      throw new Error('esperava conflito');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageEventConflictError);
      expect((err as UsageEventConflictError).event_id).toBe('e1');
      expect((err as Error).message).not.toContain('9999');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T59 — estimated/unknown visíveis; zero não é fabricado
// ───────────────────────────────────────────────────────────────────────────

describe('T59 — `estimated`/`unknown` são estados VISÍVEIS', () => {
  it('8. o vocabulário é o do §9.2, fechado', () => {
    expect([...USAGE_EVENT_KINDS].sort()).toEqual(
      ['adjustment', 'estimated', 'reconciled', 'reported'].sort(),
    );
    expect([...ACCOUNTING_STATUSES].sort()).toEqual(
      ['estimated', 'reserved', 'settled', 'unknown'].sort(),
    );
  });

  it('9. NENHUM evento observado não é custo zero liquidado', () => {
    const r = foldUsageEvents([]);
    expect(r.total_microusd).toBe('0');
    expect(r.status).toBe('reserved');
    expect(r.status).not.toBe('settled');
  });

  it('10. lookup de preço falhou (`delta=null`) vira `unknown`, não zero', () => {
    const r = foldUsageEvents([
      ev({ event_id: 'e1', kind: 'estimated', delta_microusd: null, source: 'unavailable' }),
    ]);
    expect(r.status).toBe('unknown');
    expect(r.unknown_events).toBe(1);
  });

  it('11. usage ausente ao lado de custo conhecido ainda contamina para `unknown`', () => {
    // O que se sabe continua somado; o que NÃO se sabe continua visível. Deixar
    // o status `settled` aqui afirmaria conhecer a fatura inteira.
    const r = foldUsageEvents([
      ev({ event_id: 'e1', delta_microusd: '1000' }),
      ev({ event_id: 'e2', delta_microusd: null, source: 'unavailable' }),
    ]);
    expect(r.total_microusd).toBe('1000');
    expect(r.status).toBe('unknown');
  });

  it('12. `settled` exige evidência: só `reported`/`reconciled` com valor', () => {
    expect(foldUsageEvents([ev({ event_id: 'e1', kind: 'reported' })]).status).toBe('settled');
    expect(
      foldUsageEvents([ev({ event_id: 'e1', kind: 'reconciled', source: 'provider_accounted' })])
        .status,
    ).toBe('settled');
  });

  it('13. só ESTIMATIVA nunca vira `settled`', () => {
    const r = foldUsageEvents([
      ev({ event_id: 'e1', kind: 'estimated', delta_microusd: '500', source: 'gateway_estimated' }),
    ]);
    expect(r.status).toBe('estimated');
  });

  it('14. zero REPORTADO pelo provider é evidência, e pode liquidar', () => {
    // A régua é a evidência, não o número: zero com evidência é diferente de
    // zero por ausência (caso 9).
    const r = foldUsageEvents([ev({ event_id: 'e1', kind: 'reported', delta_microusd: '0' })]);
    expect(r.total_microusd).toBe('0');
    expect(r.status).toBe('settled');
  });

  it('15. `unknown` domina `estimated`, que domina `settled`', () => {
    const r = foldUsageEvents([
      ev({ event_id: 'e1', kind: 'reported', delta_microusd: '10' }),
      ev({ event_id: 'e2', kind: 'estimated', delta_microusd: '20', source: 'gateway_estimated' }),
      ev({ event_id: 'e3', kind: 'estimated', delta_microusd: null, source: 'unavailable' }),
    ]);
    expect(r.status).toBe('unknown');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T56 — falha de provider com possível cobrança
// ───────────────────────────────────────────────────────────────────────────

describe('T56 — falha de provider não zera custo', () => {
  it('16. 429 depois da exposição estimada preserva o custo estimado', () => {
    const r = foldUsageEvents([
      ev({
        event_id: 'exposicao-1',
        kind: 'estimated',
        delta_microusd: '5000',
        source: 'gateway_estimated',
      }),
    ]);
    expect(r.total_microusd).toBe('5000');
    expect(r.status).toBe('estimated');
    expect(r.total_microusd).not.toBe('0');
  });

  it('17. stream parcial sem usage fica `unknown`, não zero', () => {
    const r = foldUsageEvents([
      ev({
        event_id: 'exposicao-1',
        kind: 'estimated',
        delta_microusd: '5000',
        source: 'gateway_estimated',
      }),
      ev({ event_id: 'obs-1', kind: 'reported', delta_microusd: null, source: 'unavailable' }),
    ]);
    expect(r.status).toBe('unknown');
    expect(r.total_microusd).toBe('5000');
  });

  it('18. evidência nova AJUSTA com evento compensatório, sem apagar o original', () => {
    const r = foldUsageEvents([
      ev({
        event_id: 'exposicao-1',
        kind: 'estimated',
        delta_microusd: '5000',
        source: 'gateway_estimated',
      }),
      ev({
        event_id: 'ajuste-1',
        kind: 'adjustment',
        delta_microusd: '-2000',
        source: 'provider_accounted',
      }),
    ]);
    expect(r.total_microusd).toBe('3000');
    // A cobrança original CONTINUA na trilha — o ajuste não a apagou.
    expect(r.counted_event_ids).toContain('exposicao-1');
    expect(r.counted_event_ids).toContain('ajuste-1');
  });

  it('19. só `adjustment` pode ser negativo', () => {
    expect(() =>
      foldUsageEvents([ev({ event_id: 'e1', kind: 'reported', delta_microusd: '-10' })]),
    ).toThrow();

    // ISOLA a guarda POR EVENTO. No caso acima o total também ficaria negativo,
    // então a guarda de total cobriria a ausência desta — duas guardas, um só
    // teste, e a mutação provou que apagar a do evento não matava nada. Aqui o
    // total fica em 90, positivo: só a guarda do evento pode recusar.
    expect(() =>
      foldUsageEvents([
        ev({ event_id: 'e1', kind: 'reported', delta_microusd: '100' }),
        ev({ event_id: 'e2', kind: 'reported', delta_microusd: '-10' }),
      ]),
    ).toThrow(/adjustment/);
  });

  it('20. ajuste que levaria o total a NEGATIVO é defeito, não saldo a favor', () => {
    expect(() =>
      foldUsageEvents([
        ev({ event_id: 'e1', kind: 'estimated', delta_microusd: '100', source: 'gateway_estimated' }),
        ev({ event_id: 'a1', kind: 'adjustment', delta_microusd: '-500' }),
      ]),
    ).toThrow();
  });

  it('21. retry limitado: três tentativas cobradas somam as TRÊS', () => {
    // O §6.10 item 5 exige que o ledger cubra SDK retries. Cada tentativa que
    // chegou ao provider é um evento próprio.
    const r = foldUsageEvents([
      ev({ event_id: 'try-1', kind: 'estimated', delta_microusd: '100', source: 'gateway_estimated' }),
      ev({ event_id: 'try-2', kind: 'estimated', delta_microusd: '100', source: 'gateway_estimated' }),
      ev({ event_id: 'try-3', kind: 'reported', delta_microusd: '150' }),
    ]);
    expect(r.total_microusd).toBe('350');
  });
});

describe('P06 — dinheiro é inteiro, nunca float', () => {
  it('22. valores acima de MAX_SAFE_INTEGER somam EXATO', () => {
    const grande = '9007199254740993'; // 2^53 + 1
    const r = foldUsageEvents([
      ev({ event_id: 'e1', delta_microusd: grande }),
      ev({ event_id: 'e2', delta_microusd: '1' }),
    ]);
    expect(r.total_microusd).toBe('9007199254740994');
  });

  it('23. delta não inteiro é recusado', () => {
    for (const ruim of ['1.5', '1e3', ' 10', '10 ', '', 'abc', '+10', '007']) {
      expect(
        () => foldUsageEvents([ev({ event_id: 'e1', delta_microusd: ruim })]),
        `aceitou delta inválido: ${JSON.stringify(ruim)}`,
      ).toThrow();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T58 — reserva e admissão simultânea
// ───────────────────────────────────────────────────────────────────────────

describe('T58 — limite diário com admissões simultâneas', () => {
  it('24. admite enquanto cabe', () => {
    const d = decideAdmission(conta(), { estimate_microusd: '1000', calls_so_far: 0, max_inference_calls: 10 }, { on_unpriced: 'deny' });
    expect(d).toMatchObject({ kind: 'admit', reserve_microusd: '1000' });
  });

  it('25. recusa quando estouraria o limite', () => {
    const d = decideAdmission(
      conta({ limit_microusd: '1000', reserved_microusd: '900' }),
      { estimate_microusd: '200', calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(d).toMatchObject({ kind: 'refuse', code: 'budget_exhausted' });
  });

  it('26. o que já foi LIQUIDADO também conta contra o limite', () => {
    const d = decideAdmission(
      conta({ limit_microusd: '1000', reserved_microusd: '0', settled_microusd: '950' }),
      { estimate_microusd: '100', calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(d).toMatchObject({ kind: 'refuse', code: 'budget_exhausted' });
  });

  it('27. N admissões SIMULTÂNEAS nunca ultrapassam o limite', () => {
    // A pureza modela a serialização que o lock do §9.2 impõe: cada decisão vê
    // a conta já alterada pela anterior. É isso que faz 10 pedidos de 30 com
    // teto 100 admitirem 3, e não 10 — o defeito clássico do check-then-act.
    let c = conta({ limit_microusd: '100' });
    let admitidas = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideAdmission(
        c,
        { estimate_microusd: '30', calls_so_far: i, max_inference_calls: 100 },
        { on_unpriced: 'deny' },
      );
      if (d.kind === 'admit') {
        admitidas++;
        c = applyAdmission(c, d);
      }
    }
    expect(admitidas).toBe(3);
    expect(BigInt(c.reserved_microusd) <= BigInt(c.limit_microusd)).toBe(true);
    expect(c.reserved_microusd).toBe('90');
  });

  it('27b. exposição EXATAMENTE igual ao limite é admitida (a fronteira, nos dois lados)', () => {
    const cheia = decideAdmission(
      conta({ limit_microusd: '100', reserved_microusd: '40', settled_microusd: '30' }),
      { estimate_microusd: '30', calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(cheia.kind).toBe('admit');

    const estourada = decideAdmission(
      conta({ limit_microusd: '100', reserved_microusd: '40', settled_microusd: '30' }),
      { estimate_microusd: '31', calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(estourada).toMatchObject({ kind: 'refuse', code: 'budget_exhausted' });
  });

  it('28. cada admissão avança `row_version` (o CAS do §9.2)', () => {
    const c = conta();
    const d = decideAdmission(c, { estimate_microusd: '10', calls_so_far: 0, max_inference_calls: 10 }, { on_unpriced: 'deny' });
    if (d.kind !== 'admit') throw new Error('esperava admissão');
    expect(applyAdmission(c, d).row_version).toBe(c.row_version + 1);
  });

  it('29. teto de chamadas é recusa PRÓPRIA, diferente de orçamento', () => {
    const d = decideAdmission(
      conta(),
      { estimate_microusd: '1', calls_so_far: 5, max_inference_calls: 5 },
      { on_unpriced: 'deny' },
    );
    expect(d).toMatchObject({ kind: 'refuse', code: 'inference_limit_exceeded' });
  });

  it('30. store indisponível => NENHUMA inferência nova (§9.2)', () => {
    const d = decideAdmission(null, { estimate_microusd: '1', calls_so_far: 0, max_inference_calls: 10 }, { on_unpriced: 'deny' });
    expect(d).toMatchObject({ kind: 'refuse', code: 'admission_unavailable' });
  });
});

describe('T58 — sem promessa indevida de hard cap', () => {
  it('31. TODA decisão declara que a garantia é só de admissão', () => {
    const admitida = decideAdmission(conta(), { estimate_microusd: '1', calls_so_far: 0, max_inference_calls: 10 }, { on_unpriced: 'deny' });
    const recusada = decideAdmission(
      conta({ limit_microusd: '0' }),
      { estimate_microusd: '1', calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(ADMISSION_GUARANTEE).toBe('admission_only');
    expect(admitida.guarantee).toBe('admission_only');
    expect(recusada.guarantee).toBe('admission_only');
  });

  it('32. sem preço verificável, a POLÍTICA decide — e ela é parâmetro', () => {
    // §9.2: "sem preço/limite superior verificável, modo de hard cap fica
    // desabilitado ou a admissão é negada conforme policy". Ler isso de uma
    // constante do módulo seria política minha disfarçada de leitura.
    const negada = decideAdmission(
      conta(),
      { estimate_microusd: null, calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'deny' },
    );
    expect(negada).toMatchObject({ kind: 'refuse', code: 'budget_exhausted' });

    const admitida = decideAdmission(
      conta(),
      { estimate_microusd: null, calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'admit_unpriced' },
    );
    expect(admitida.kind).toBe('admit');
  });

  it('33. admissão sem preço reserva `null`, NUNCA zero (T59 do lado da reserva)', () => {
    const d = decideAdmission(
      conta(),
      { estimate_microusd: null, calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'admit_unpriced' },
    );
    if (d.kind !== 'admit') throw new Error('esperava admissão');
    expect(d.reserve_microusd).toBeNull();
    expect(d.hard_cap_enabled).toBe(false);
  });

  it('34. admissão PRECIFICADA também não promete hard cap, mas o teto está ligado', () => {
    const d = decideAdmission(conta(), { estimate_microusd: '10', calls_so_far: 0, max_inference_calls: 10 }, { on_unpriced: 'deny' });
    if (d.kind !== 'admit') throw new Error('esperava admissão');
    expect(d.hard_cap_enabled).toBe(true);
    expect(d.guarantee).toBe('admission_only');
  });

  it('35. admissão sem preço NÃO move a exposição reservada', () => {
    const c = conta();
    const d = decideAdmission(
      c,
      { estimate_microusd: null, calls_so_far: 0, max_inference_calls: 10 },
      { on_unpriced: 'admit_unpriced' },
    );
    if (d.kind !== 'admit') throw new Error('esperava admissão');
    const depois = applyAdmission(c, d);
    expect(depois.reserved_microusd).toBe('0');
    // ...mas a tentativa CONTA, então o row_version anda e o teto de chamadas
    // continua sendo o freio.
    expect(depois.row_version).toBe(c.row_version + 1);
  });
});

describe('P06 — os módulos de custo são PUROS', () => {
  it('36. nenhum import de banco, cache, config, log ou métrica', () => {
    for (const [nome, fonte] of [
      ['cost-accounting', fonteAccounting],
      ['cost-reservation', fonteReservation],
    ] as const) {
      for (const p of ['@/db/', '@/lib/redis', '@/config/', '@/lib/logger', '@/lib/metrics', 'ioredis']) {
        expect(fonte.includes(`from '${p}`), `${nome} importa ${p}`).toBe(false);
      }
    }
  });

  it('37. nenhum relógio próprio: o período/instante entra por parâmetro', () => {
    for (const fonte of [fonteAccounting, fonteReservation]) {
      expect(fonte).not.toContain('Date.now()');
      expect(fonte).not.toContain('new Date()');
    }
  });

  it('38. nenhuma aritmética de ponto flutuante em dinheiro', () => {
    // `parseFloat`/`Number(` sobre microusd é exatamente como uma fatura some
    // no arredondamento. A casa já escolheu string decimal (§5.3.1).
    for (const fonte of [fonteAccounting, fonteReservation]) {
      expect(fonte).not.toContain('parseFloat');
      expect(fonte).not.toContain('toFixed');
    }
  });
});
