/**
 * Issue #506 (ratificação) — DONO, PRAZO e CONDIÇÃO DE REMOÇÃO das seis
 * exceções de egresso.
 *
 * O dono recusou ratificar as seis em bloco:
 *
 *   > "Não ratifico as seis exceções em bloco. Tragam uma tabela por exceção
 *   >  com callsite, justificativa, controle fail-closed, owner, prazo e
 *   >  condição de remoção."
 *
 * Três dos seis campos não existiam. Este arquivo é a prova de que os três
 * novos não podem apodrecer em silêncio, e ele guarda coisas DIFERENTES do
 * `outbound-trava-envio-direto.spec.ts` — aquele prova que ninguém envia fora
 * do inventário e que o inventário não cresce; este prova que cada linha do
 * inventário ou está COMPLETA ou está VISIVELMENTE incompleta.
 *
 * ─── As três guardas, e o que cada uma impede ──────────────────────────────
 *
 *   `owner`   — vocabulário FECHADO. Um `owner: string` aceitaria `"time"`,
 *               `"a plataforma"` e `""`. O ADR 0005 já traz `Owner: Maia
 *               maintainers` no cabeçalho, que é exatamente o dono coletivo
 *               que a recusa mira: quando o prazo vence, um time não recebe
 *               e-mail.
 *   `deadline`— uma data que VENCE. É o que separa "exceção temporária" de
 *               "exceção permanente por esquecimento" — o mesmo mecanismo do
 *               ledger de `npm audit` (#526/#574,
 *               `scripts/check-audit-exceptions.ts`), e pelo mesmo motivo.
 *   `removal` — o FATO verificável que apaga a entrada, com SONDA. É o campo
 *               mais fácil de escrever mal: "quando der" e "quando a
 *               arquitetura permitir" são adiamentos com data aberta, não
 *               condições.
 *
 * ─── A sonda de remoção é uma tripwire de DUAS pontas ──────────────────────
 *
 * `condicaoDeRemocaoAindaNaoVale` não confere só que a condição está escrita:
 * ele confere que ela é FALSA hoje. Se o símbolo aparecer no módulo indicado —
 * alguém implementou `commitStandaloneOutbound`, alguém declarou `reaction`
 * como idempotência nativa —, este teste fica VERMELHO dizendo que a condição
 * de remoção daquela exceção está SATISFEITA e a entrada deve sair do
 * inventário.
 *
 * É a diferença entre uma condição de remoção e uma promessa: a promessa
 * envelhece calada, e esta grita no dia em que passa a valer.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUTBOUND_EXCEPTION_OWNERS,
  OUTBOUND_SEND_PATHS,
  OWNER_PENDENTE,
  PENDING_OWNER_DECISION_IDS,
  assertRatifiedInventory,
  declaredExceptions,
  expiredExceptions,
  isCalendarDate,
  isPendingOwnerDecision,
  pendingOwnerDecisions,
  todayUtc,
  type OutboundSendPath,
} from '@/runtime/outbound/send-paths.js';

/**
 * Uma entrada DELIBERADAMENTE quebrada, para exercitar a guarda de RUNTIME.
 *
 * Os três campos novos são obrigatórios no TIPO: uma exceção sem dono ou sem
 * condição de remoção não compila, e essa metade da defesa não tem como ser
 * testada — código que não compila não roda. A metade que este `as` exercita é
 * a que sobra: o que atravessa um cast, um JSON, uma entrada montada em tempo
 * de execução.
 */
function comCampoQuebrado(
  base: OutboundSendPath,
  campos: Record<string, unknown>,
): OutboundSendPath {
  return { ...base, ...campos } as unknown as OutboundSendPath;
}

/** O inventário de produção com UMA exceção substituída pela versão quebrada. */
function inventarioCom(id: string, campos: Record<string, unknown>): OutboundSendPath[] {
  const cobaia = OUTBOUND_SEND_PATHS.find((p) => p.id === id);
  expect(cobaia, `a cobaia '${id}' saiu do inventário — escolha outra exceção viva`).toBeDefined();
  return [...OUTBOUND_SEND_PATHS.filter((p) => p.id !== id), comCampoQuebrado(cobaia!, campos)];
}

/** Comentário fora, código dentro — a mesma redução do teste de trava. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('#506 — dono, prazo e condição de remoção: as guardas', () => {
  it('um owner fora do vocabulário FECHADO é recusado — dono é pessoa, não time', () => {
    // A redação exata que o ADR 0005 usa no cabeçalho. Ela passaria num campo
    // de texto livre, e é o não-dono que a recusa da ratificação em bloco mira.
    expect(() =>
      assertRatifiedInventory(inventarioCom('identity.quarantine', { owner: 'Maia maintainers' })),
    ).toThrow(/fora do vocabulário FECHADO/);
  });

  it('um owner VAZIO é recusado — a string vazia é o dono coletivo mais barato', () => {
    expect(() =>
      assertRatifiedInventory(inventarioCom('identity.quarantine', { owner: '' })),
    ).toThrow(/fora do vocabulário FECHADO/);
  });

  it('uma condição de remoção VAZIA é recusada', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('workers.pending_reminder', {
          removal: { when: '   ', why_sufficient: 'qualquer coisa', probes: [] },
        }),
      ),
    ).toThrow(/sem condição de remoção/);
  });

  it('uma condição de remoção SEM sonda é recusada — sem sonda, o fato é prosa', () => {
    // O caso mais insidioso: a condição está ESCRITA, e bem. O que falta é o
    // lugar onde a máquina confere se ela já vale — e sem esse lugar a exceção
    // sobrevive à própria condição, que é como se chega a uma exceção
    // permanente sem ninguém decidir por isso.
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('workers.pending_reminder', {
          removal: {
            when: 'Quando a arquitetura permitir.',
            why_sufficient: 'Porque aí dá.',
            probes: [],
          },
        }),
      ),
    ).toThrow(/condição de remoção sem sonda/);
  });

  it('uma sonda com módulo ou símbolo vazio é recusada', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          removal: {
            when: 'x',
            why_sufficient: 'y',
            probes: [{ module: '', symbol: 'commitStandaloneOutbound' }],
          },
        }),
      ),
    ).toThrow(/sonda de remoção/);
  });

  it('um prazo que não é data de calendário é recusado — 2026-02-31 não existe', () => {
    // `Date.parse('2026-02-31')` normaliza para 2026-03-03 e daria três dias
    // de vida silenciosos a uma data que ninguém escreveu.
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          owner: 'diogenesmendes01',
          deadline: { kind: 'prazo', expires: '2026-02-31' },
        }),
      ),
    ).toThrow(/não é uma data YYYY-MM-DD existente/);
  });

  it('um prazo SEM dono é recusado — prazo que não vence para ninguém não vence', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          owner: OWNER_PENDENTE,
          deadline: { kind: 'prazo', expires: '2030-01-01' },
        }),
      ),
    ).toThrow(/Prazo exige dono/);
  });

  it('uma pendência NÃO DECLARADA é recusada — a lacuna nova não entra em silêncio', () => {
    // A manobra que esta guarda impede: uma rota ratificada perde o dono (ou
    // nunca ganha um) e a lista de pendências não muda. O inventário passaria a
    // ter sete lacunas com seis declaradas, e o diff não teria uma linha
    // vermelha em lugar nenhum.
    //
    // A lista entra por parâmetro porque hoje as SEIS estão nela: sem isso não
    // existe id de produção capaz de produzir a violação, e o caso seria verde
    // vazio.
    expect(() => assertRatifiedInventory(OUTBOUND_SEND_PATHS, [])).toThrow(
      /está pendente do dono[\s\S]*não consta de PENDING_OWNER_DECISION_IDS/,
    );

    // O CONTROLE: com a lista de verdade, o mesmo inventário passa. Sem ele,
    // a asserção acima também ficaria verde num guard que reprova SEMPRE.
    expect(() => assertRatifiedInventory(OUTBOUND_SEND_PATHS)).not.toThrow();

    // E uma entrada COM dono e COM prazo deixa de ser pendência: ela passa
    // mesmo com a lista de pendências VAZIA. É o que prova que a guarda mede
    // pendência, e não presença na lista.
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          owner: 'diogenesmendes01',
          deadline: { kind: 'prazo', expires: '2030-01-01' },
        }),
        PENDING_OWNER_DECISION_IDS.filter((id) => id !== 'identity.quarantine'),
      ),
    ).not.toThrow();
  });

  it('o PRAZO VENCIDO reprova — é o que impede a exceção temporária de virar permanente', () => {
    // A guarda que o dono pediu, com o relógio congelado. Hoje as seis estão
    // `pendente_do_dono`, então o caso NÃO pode depender do inventário de
    // produção para ter sujeito: ele fabrica um prazo e anda o calendário.
    const comPrazo = inventarioCom('identity.quarantine', {
      owner: 'diogenesmendes01',
      deadline: { kind: 'prazo', expires: '2026-03-31' },
    });

    // No próprio dia do vencimento ainda vale — `expires` é o último dia.
    expect(expiredExceptions(comPrazo, '2026-03-31')).toHaveLength(0);
    // No dia seguinte, não.
    const vencidas = expiredExceptions(comPrazo, '2026-04-01');
    expect(vencidas.map((e) => e.id)).toEqual(['identity.quarantine']);

    // E uma entrada `pendente_do_dono` NUNCA vence — ela não tem data. É por
    // isso que a pendência é ratchetada em vez de expirada: o que a resolve é
    // uma decisão, não a passagem do tempo.
    expect(expiredExceptions(OUTBOUND_SEND_PATHS, '2099-12-31')).toHaveLength(0);
  });

  it('`todayUtc` é UTC, e não o fuso da máquina que roda o CI', () => {
    expect(todayUtc(new Date('2026-03-31T23:59:59Z'))).toBe('2026-03-31');
    expect(todayUtc(new Date('2026-04-01T00:00:01Z'))).toBe('2026-04-01');
  });
});

describe('#506 — o inventário de PRODUÇÃO, linha a linha', () => {
  it('nenhuma exceção declarada está VENCIDA hoje', () => {
    const vencidas = expiredExceptions(OUTBOUND_SEND_PATHS, todayUtc(new Date()));
    expect(
      vencidas.map((e) => `${e.id} (venceu em ${JSON.stringify(e.deadline)}, dono ${e.owner})`),
      'renove com nova justificativa, migre a rota, ou peça ao dono um prazo novo',
    ).toEqual([]);
  });

  it('toda exceção tem os SEIS campos da tabela do dono preenchidos', () => {
    // Os três primeiros já existiam e estavam espalhados; os três últimos são
    // desta ratificação. O caso os cobra juntos porque é assim que o dono lê a
    // linha: ou ela responde às seis perguntas, ou ela está incompleta.
    const faltando: string[] = [];
    for (const e of declaredExceptions()) {
      if (e.module.trim() === '') faltando.push(`${e.id}: callsite (module)`);
      if (e.reason.trim() === '') faltando.push(`${e.id}: justificativa (reason)`);
      if (e.containment.trim() === '') faltando.push(`${e.id}: controle fail-closed (containment)`);
      if (!OUTBOUND_EXCEPTION_OWNERS.includes(e.owner)) faltando.push(`${e.id}: owner`);
      if (e.removal.when.trim() === '') faltando.push(`${e.id}: condição de remoção`);
      if (e.removal.why_sufficient.trim() === '') faltando.push(`${e.id}: por que a condição basta`);
      if (e.removal.probes.length === 0) faltando.push(`${e.id}: sonda da condição`);
    }
    expect(faltando).toEqual([]);
  });

  it('as pendências do dono são EXATAMENTE as declaradas — a lista só encolhe', () => {
    // As duas direções, e a segunda é a que impede a lista de virar depósito:
    // um id que já ganhou dono e prazo mas continua listado seria uma vaga
    // aberta esperando ocupante.
    expect(pendingOwnerDecisions().map((e) => e.id).sort()).toEqual(
      [...PENDING_OWNER_DECISION_IDS].sort(),
    );
    const orfaos = PENDING_OWNER_DECISION_IDS.filter(
      (id) => !declaredExceptions().some((e) => e.id === id && isPendingOwnerDecision(e)),
    );
    expect(
      orfaos,
      'estes ids não são mais pendências — apague-os de PENDING_OWNER_DECISION_IDS',
    ).toEqual([]);
  });

  it('todo módulo de sonda EXISTE — uma sonda cega não confere nada', () => {
    const ausentes: string[] = [];
    for (const e of declaredExceptions()) {
      for (const probe of e.removal.probes) {
        if (!existsSync(join(process.cwd(), probe.module))) {
          ausentes.push(`${e.id} → ${probe.module}`);
        }
      }
    }
    expect(ausentes).toEqual([]);
  });

  /**
   * A TRIPWIRE. Ver o cabeçalho do arquivo.
   *
   * Vermelho aqui NÃO é um defeito: é a notícia de que a condição de remoção
   * de uma exceção passou a valer. A ação é apagar a entrada do inventário, o
   * id de `RATIFIED_EXCEPTION_IDS` e baixar `MAX_DECLARED_EXCEPTIONS` — na
   * mesma PR.
   */
  it('nenhuma condição de remoção JÁ VALE — se valesse, a exceção teria de sair', () => {
    const satisfeitas: string[] = [];
    for (const e of declaredExceptions()) {
      const presentes = e.removal.probes.filter((probe) =>
        semComentarios(readFileSync(join(process.cwd(), probe.module), 'utf8')).includes(
          probe.symbol,
        ),
      );
      if (presentes.length === e.removal.probes.length) {
        satisfeitas.push(
          `${e.id}: a condição "${e.removal.when}" está SATISFEITA — apague a exceção, ` +
            `o id de RATIFIED_EXCEPTION_IDS e baixe MAX_DECLARED_EXCEPTIONS na mesma PR`,
        );
      }
    }
    expect(satisfeitas).toEqual([]);
  });

  it('cada sonda individual continua ausente — meia condição não é condição', () => {
    // Separado do caso acima de propósito. Aquele responde "a condição já
    // vale?"; este responde "alguma PARTE dela já vale?", e a diferença
    // importa: `workers.pending_reminder` tem três sondas, e quando duas
    // acenderem alguém precisa saber que falta uma — não descobrir isso no dia
    // em que a terceira acender.
    const acesas: string[] = [];
    for (const e of declaredExceptions()) {
      for (const probe of e.removal.probes) {
        const corpo = semComentarios(readFileSync(join(process.cwd(), probe.module), 'utf8'));
        if (corpo.includes(probe.symbol)) acesas.push(`${e.id} → ${probe.module}: ${probe.symbol}`);
      }
    }
    expect(
      acesas,
      'estas sondas acenderam: a condição de remoção correspondente avançou. Confira se a ' +
        'exceção ainda se justifica e, se não, apague-a; se ainda se justifica, a condição ' +
        'escrita está errada e precisa ser reescrita — não relaxada.',
    ).toEqual([]);
  });
});
