/**
 * SC04 (§5.3.2, §5.6.2–5.6.4) — o caminho DURÁVEL: hooks aguardados, identidade
 * congelada e RECEIPTS reais.
 *
 * ─── O que esta suíte prova, e onde ─────────────────────────────────────────
 *
 * O objeto aqui é `dispatchToolDurable`. O que é FALSO é só o ledger de
 * idempotência (mockado, para que cada transição possa ser observada
 * isoladamente, e para que a chave “candidata” e a “congelada” sejam
 * distinguíveis). O resto é real: o CORPO do dispatcher, os guards de posse e
 * de prazo, os hooks do controle e a materialização do receipt.
 *
 * As quatro afirmações centrais:
 *
 *  1. `freezeIdentity` é aguardado ANTES de aprovação/reserva, e o despacho
 *     segue com a chave PERSISTIDA — não com a recalculada. É a razão de ser do
 *     congelamento: depois de uma virada de bucket, recalcular produziria uma
 *     identidade que o journal não reconhece.
 *  2. `beforeHandler` recebe o `reservation_token` REAL da reserva (não um
 *     `res-<call_id>` inventado no wrapper) e falha dele IMPEDE o handler.
 *  3. O receipt carrega classificação, timestamps e evidência de efeito
 *     derivada do ESTADO — resposta de handler não promove nada a `committed`.
 *  4. Perda de posse devolve `ownership_lost`, e o resultado do handler é
 *     descartado: não existe receipt para um turno que já não é dono.
 *
 * A perna de banco real (rows conferidas, aprovação real, idempotência real) é
 * a suíte irmã: `tests/integration/refinement-sc04-real-db.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const { recorder } = vi.hoisted(() => ({
  recorder: {
    ordem: [] as string[],
    tryReserveCalls: [] as Array<Record<string, unknown>>,
    markCompletedCalls: [] as Array<Record<string, unknown>>,
    abandonReservationCalls: [] as Array<{ key: string; reservation_token: string }>,
    releaseReservationCalls: [] as Array<{ key: string; reservation_token: string }>,
    handlerCalls: 0,
    duranteOHandler: (() => {}) as () => void,
    handlerResult: { ok: true, from: 'handler' } as unknown,
    markCompletedResult: true,
    reserveResult: null as null | Record<string, unknown>,
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async (input: Record<string, unknown>) => {
      recorder.ordem.push('tryReserve');
      recorder.tryReserveCalls.push(input);
      if (recorder.reserveResult !== null) return recorder.reserveResult;
      return {
        was_inserted: true,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: 'token-real-1',
      };
    }),
    lookup: vi.fn(async () => null),
    waitForCompletion: vi.fn(async () => ({ status: 'timeout' })),
    markCompleted: vi.fn(async (input: Record<string, unknown>) => {
      recorder.markCompletedCalls.push(input);
      return recorder.markCompletedResult;
    }),
    releaseReservation: vi.fn(async (input: { key: string; reservation_token: string }) => {
      recorder.releaseReservationCalls.push(input);
      return true;
    }),
    abandonReservation: vi.fn(async (input: { key: string; reservation_token: string }) => {
      recorder.abandonReservationCalls.push(input);
      return true;
    }),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
  idempotencyOutboxRepo: {
    markCompletedWithEffect: vi.fn(async (input: Record<string, unknown>) => {
      recorder.markCompletedCalls.push(input);
      return recorder.markCompletedResult;
    }),
  },
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => ({
      granted_packs: [],
      granted_tools: ['sc04_write', 'sc04_safe', 'sc04_report', 'sc04_desconhecida'],
      denied_tools: [],
    })),
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/governance/idempotency.js', () => ({
  // A chave “candidata” — recalculada no corpo. O valor é DELIBERADAMENTE
  // diferente da identidade que o controle devolve, para que os testes
  // distingam “o despacho usou a congelada” de “o despacho recalculou”.
  computeIdempotencyKey: vi.fn(() => 'chave-candidata-recalculada'),
  computePayloadHash: vi.fn(() => 'hash-candidato'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual =
    await vi.importActual<typeof import('@/governance/permissions.js')>('@/governance/permissions.js');
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

const { tools } = vi.hoisted(() => {
  const passthrough = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
  const mk = (name: string, effect_class: string, side_effect: string) => ({
    name,
    description: name,
    input_schema: passthrough,
    output_schema: passthrough,
    required_actions: [],
    side_effect,
    effect_class,
    redis_required: false,
    operation_type: 'create',
    audit_action: 'fact_saved',
    feature_flag: undefined,
    handler: async () => {
      recorder.handlerCalls += 1;
      recorder.duranteOHandler();
      return recorder.handlerResult;
    },
  });
  return {
    tools: {
      sc04_write: mk('sc04_write', 'non_interruptible', 'write'),
      sc04_safe: mk('sc04_safe', 'abort_safe', 'read'),
      sc04_report: mk('sc04_report', 'idempotent', 'write'),
    },
  };
});

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: tools,
  isToolEnabled: () => true,
}));

import { dispatchToolDurable, BeforeHandlerError } from '@/tools/_dispatcher.js';
import type { ToolContext } from '@/tools/_dispatcher.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { Pessoa, Conversa } from '@/db/schema.js';
import type {
  DurableDispatchControlV1,
  DurableDispatchResultV1,
  EngineToolCallV1,
  EngineToolReplyV1,
  ToolReceiptV1,
} from '@/runtime/engines/contracts.js';
import { toolReceiptV1Schema, durableDispatchResultV1Schema } from '@/runtime/engines/schemas.js';
import { createEngineToolGateway } from '@/integrations/hermes/tool-gateway.js';
import type { ToolGatewayDepsV1 } from '@/integrations/hermes/tool-gateway.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import type { FreezeIdentityResult, ToolClassification } from '@/db/repositories/engine-repos.js';

const ctx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

function turnContext(controller: AbortController, deadline: Date): TurnExecutionContext {
  return {
    tenant_id: 'primary',
    agent_id: 'primary',
    turn_id: 'turno-1',
    attempt: 1,
    claim_token: 'claim-1',
    worker_id: 'worker-1',
    deadline,
    signal: controller.signal,
  };
}

const daquiA = (ms: number): Date => new Date(Date.now() + ms);

function mkControl(over: Partial<DurableDispatchControlV1> = {}): DurableDispatchControlV1 {
  return {
    call_id: 'call-1',
    call_ordinal: 0,
    dispatch_token: randomUUID(),
    classification: {
      side_effect: 'write',
      effect_class: 'non_interruptible',
      sensitive: false,
      legacy_irreversible_invoked: false,
    },
    freezeIdentity: async (candidate) => {
      recorder.ordem.push('freezeIdentity');
      return { key: 'chave-congelada-no-journal', payload_hash: candidate.payload_hash };
    },
    recordApproval: async () => {
      recorder.ordem.push('recordApproval');
    },
    beforeHandler: async (input) => {
      recorder.ordem.push(`beforeHandler:${input.reservation_token}`);
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.ordem = [];
  recorder.tryReserveCalls = [];
  recorder.markCompletedCalls = [];
  recorder.abandonReservationCalls = [];
  recorder.releaseReservationCalls = [];
  recorder.handlerCalls = 0;
  recorder.duranteOHandler = () => {};
  recorder.handlerResult = { ok: true, from: 'handler' };
  recorder.markCompletedResult = true;
  recorder.reserveResult = null;
});

describe('SC04-AC01/AC02 — a identidade CONGELADA é a que o despacho usa', () => {
  it('aguarda freezeIdentity ANTES da reserva e reserva com a chave persistida', async () => {
    const controller = new AbortController();
    const control = mkControl();

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: { texto: 'oi' }, ctx }, control),
    );

    expect(out.kind).toBe('settled');
    // A ORDEM é a afirmação: congelar vem antes de reservar. Congelar depois
    // seria decorativo — o lookup/reserva já teriam usado a chave recalculada.
    expect(recorder.ordem[0]).toBe('freezeIdentity');
    expect(recorder.ordem).toContain('tryReserve');
    expect(recorder.ordem.indexOf('freezeIdentity')).toBeLessThan(recorder.ordem.indexOf('tryReserve'));

    // E a chave que chegou ao ledger é a do journal, NÃO a candidata.
    expect(recorder.tryReserveCalls[0]?.['key']).toBe('chave-congelada-no-journal');
    expect(recorder.tryReserveCalls[0]?.['key']).not.toBe('chave-candidata-recalculada');
  });

  it('recusa seguir quando o controle não devolve a identidade PERSISTIDA', async () => {
    const controller = new AbortController();
    // Sem chave persistida não se sabe qual identidade o journal guarda; seguir
    // com a candidata reintroduziria exatamente o defeito que o congelamento
    // existe para impedir.
    const control = mkControl({
      freezeIdentity: async () => ({ key: undefined as unknown as string, payload_hash: undefined as unknown as string }),
    });

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, control),
    );

    expect(out).toMatchObject({ kind: 'journal_unavailable', handler_may_have_started: false });
    expect(recorder.handlerCalls).toBe(0);
    expect(recorder.tryReserveCalls).toHaveLength(0);
  });
});

describe('SC04-AC03 — beforeHandler é o limite do efeito, com tokens REAIS', () => {
  it('recebe o reservation_token real da reserva, e o completion usa o MESMO token', async () => {
    const controller = new AbortController();
    const control = mkControl();

    await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, control),
    );

    expect(recorder.ordem).toContain('beforeHandler:token-real-1');
    expect(recorder.ordem.indexOf('tryReserve')).toBeLessThan(
      recorder.ordem.indexOf('beforeHandler:token-real-1'),
    );
    // Nenhum `res-<call_id>`: o token que o marcador persistiu é o mesmo que o
    // ledger usa para fechar a reserva.
    expect(recorder.markCompletedCalls[0]?.['reservation_token']).toBe('token-real-1');
    expect(JSON.stringify(recorder.ordem)).not.toContain('res-');
  });

  it('recusa TIPADA do hook impede o handler e ABANDONA a reserva', async () => {
    const controller = new AbortController();
    const control = mkControl({
      beforeHandler: async () => {
        throw new BeforeHandlerError(false);
      },
    });

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, control),
    );

    expect(out).toEqual({ kind: 'journal_unavailable', handler_may_have_started: false });
    expect(recorder.handlerCalls).toBe(0);
    expect(recorder.markCompletedCalls).toHaveLength(0);
    // O handler nunca começou: a reserva é APAGADA. Marcá-la 'failed' é
    // terminal e negaria serviço ao dono legítimo por uma execução que não
    // existiu.
    expect(recorder.abandonReservationCalls).toEqual([
      { key: 'chave-congelada-no-journal', reservation_token: 'token-real-1' },
    ]);
    expect(recorder.releaseReservationCalls).toEqual([]);
  });

  it('falha NÃO tipada do hook é conservadora: a reserva vira `failed`', async () => {
    const controller = new AbortController();
    const control = mkControl({
      beforeHandler: async () => {
        throw new Error('banco fora do ar');
      },
    });

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, control),
    );

    // Não dá para provar que o marcador NÃO foi gravado: o desfecho honesto é
    // "pode ter começado", e é ele que manda o run para reconciliação.
    expect(out).toEqual({ kind: 'journal_unavailable', handler_may_have_started: true });
    expect(recorder.handlerCalls).toBe(0);
    expect(recorder.abandonReservationCalls).toEqual([]);
    expect(recorder.releaseReservationCalls).toEqual([
      { key: 'chave-congelada-no-journal', reservation_token: 'token-real-1' },
    ]);
  });
});

describe('SC04-AC04/AC05 — o receipt é materializado, e a projeção é separada', () => {
  it('receipt íntegro: classificação, timestamps, evidência e prova de efeito', async () => {
    const controller = new AbortController();
    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, mkControl()),
    );

    expect(out.kind).toBe('settled');
    if (out.kind !== 'settled') throw new Error('esperado settled');
    const r = out.receipt;

    expect(r).toMatchObject({
      call_id: 'call-1',
      ordinal: 0,
      name: 'sc04_write',
      status: 'success',
      side_effect: 'write',
      effect_class: 'non_interruptible',
      sensitive: false,
      legacy_irreversible_invoked: false,
      // AC07: a evidência vem do ESTADO (reserva concluída), nunca do payload.
      effect_evidence: 'committed',
      approval: null,
      pending_question_id: null,
      report: null,
      result_for_engine: { ok: true, from: 'handler' },
    });
    expect(r.started_at).not.toBeNull();
    expect(r.finished_at >= r.started_at!).toBe(true);
    expect(r.summary.tool_call_id).toBe('call-1');
    expect(r.summary.side_effect).toBe('write');

    // O contrato do §5.3.2 é EXECUTÁVEL: o receipt materializado passa pelo
    // schema — inclusive pela regra de `null` só antes do registry.
    expect(toolReceiptV1Schema.safeParse(r).success).toBe(true);
    expect(durableDispatchResultV1Schema.safeParse(out).success).toBe(true);
  });

  it('relatório: o motor recebe a PROJEÇÃO, e o journal guarda o resultado protegido', async () => {
    const controller = new AbortController();
    // A forma REAL de `generate_report` (`src/tools/generate-report.ts`): o
    // caminho e o sumário do PDF vivem no nível de cima do resultado.
    recorder.handlerResult = {
      path: '/var/maia/relatorios/extrato-1.pdf',
      fileName: 'extrato-1.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
      summary: 'Extrato de 01/09 a 30/09 — 12 lançamentos',
    };

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_report', args: {}, ctx }, mkControl()),
    );
    if (out.kind !== 'settled') throw new Error('esperado settled');
    const r = out.receipt;

    // O caminho existe no PROTEGIDO...
    expect((r.result as Record<string, unknown>)['path']).toBe(
      '/var/maia/relatorios/extrato-1.pdf',
    );
    // ...e NÃO atravessa para o motor.
    const proj = r.result_for_engine as Record<string, unknown>;
    expect(proj['path']).toBeUndefined();
    expect(proj['fileName']).toBeUndefined();
    expect(proj['summary']).toBeUndefined();
    /**
     * LIMITE DECLARADO da projeção: ela remove o que o CONTRATO nomeia
     * (`path`, `fileName`, `summary` e a mídia de um `report` aninhado). Ela não
     * é um allowlist por ferramenta — não teria como ser, sem conhecer o
     * `output_schema` de cada uma —, então um campo interno com OUTRO nome
     * continua dependendo do autor da tool. Está registrado nas limitações do
     * card.
     */
    // O relatório durável fica registrado com a mídia e o tipo.
    expect(r.report).toMatchObject({
      file_name: 'extrato-1.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
      media: { kind: 'local_path', path: '/var/maia/relatorios/extrato-1.pdf' },
    });
    expect(toolReceiptV1Schema.safeParse(r).success).toBe(true);
  });

  it('AC06/T29 — recusa ANTES do registry: classes `null`, e o schema aceita', async () => {
    const controller = new AbortController();
    const control = mkControl({
      beforeHandler: async () => {
        recorder.ordem.push('beforeHandler');
      },
    });

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'tool_que_nao_existe', args: {}, ctx }, control),
    );

    if (out.kind !== 'settled') throw new Error('esperado settled');
    expect(out.receipt).toMatchObject({
      status: 'error',
      // `null` nas DUAS, e `abort_safe` jamais inventado para uma tool
      // desconhecida: não há spec para descrever o efeito.
      side_effect: null,
      effect_class: null,
      effect_evidence: 'none',
      started_at: null,
    });
    expect(out.receipt.result).toMatchObject({ error: 'unknown_tool' });
    expect(recorder.handlerCalls).toBe(0);
    // A recusa é anterior ao limite do efeito: o marcador NÃO foi chamado.
    expect(recorder.ordem).not.toContain('beforeHandler');
    expect(toolReceiptV1Schema.safeParse(out.receipt).success).toBe(true);
  });

  it('AC07 — classe SEM efeito concluída não inventa prova de efeito', async () => {
    const controller = new AbortController();
    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable(
        { tool: 'sc04_safe', args: {}, ctx },
        mkControl({
          classification: {
            side_effect: 'read',
            effect_class: 'abort_safe',
            sensitive: false,
            legacy_irreversible_invoked: false,
          },
        }),
      ),
    );

    if (out.kind !== 'settled') throw new Error('esperado settled');
    // `abort_safe` declara não haver efeito: `none` é a verdade, e promovê-la a
    // `committed` seria afirmar um efeito que a classe nega.
    expect(out.receipt.effect_evidence).toBe('none');
    expect(recorder.markCompletedCalls).toHaveLength(1);
  });

  it('AC07 — completion FENCED mantém `unknown` em vez de afirmar efeito', async () => {
    const controller = new AbortController();
    recorder.markCompletedResult = false; // fence perdida: o ledger recusou

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, mkControl()),
    );

    if (out.kind !== 'settled') throw new Error('esperado settled');
    // O handler rodou inteiro e o resultado não virou cache autoritativo:
    // "houve efeito?" segue sem resposta.
    expect(out.receipt.effect_evidence).toBe('unknown');
    expect(out.receipt.effect_evidence).not.toBe('committed');
    expect(recorder.handlerCalls).toBe(1);
  });

  it('AC07 — a evidência nunca REGRIDE para `none` depois do marcador', async () => {
    const controller = new AbortController();
    // Adoção de uma reserva que OUTRO dono marcou terminal como `failed`: o
    // handler não roda AQUI, mas pode ter rodado lá — e pode ter deixado efeito.
    recorder.reserveResult = { was_inserted: false, state: 'failed', resultado: undefined };

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, mkControl()),
    );

    if (out.kind !== 'settled') throw new Error('esperado settled');
    expect(out.receipt).toMatchObject({
      status: 'error',
      result: { error: 'idempotency_prior_failed' },
    });
    expect(recorder.handlerCalls).toBe(0);
    // Classe COM efeito + desfecho duvidoso: `possible` é a resposta honesta, e
    // `none` — "não houve efeito" — nunca volta a ser afirmável (§5.6.2).
    expect(out.receipt.effect_evidence).toBe('possible');
    expect(out.receipt.effect_evidence).not.toBe('none');
    expect(out.receipt.started_at).toBeNull();
  });

  it('AC07 — erro DEVOLVIDO pelo handler conclui o ledger: `committed` é a prova real', async () => {
    const controller = new AbortController();
    // Erro de negócio devolvido (não lançado): a tool RODOU e a reserva
    // completou. O que o receipt publica é a prova que existe — o ledger —, e
    // não uma leitura do payload de negócio.
    recorder.handlerResult = { error: 'conta inexistente' };

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable({ tool: 'sc04_write', args: {}, ctx }, mkControl()),
    );

    if (out.kind !== 'settled') throw new Error('esperado settled');
    expect(out.receipt.status).toBe('error');
    expect(recorder.handlerCalls).toBe(1);
    expect(recorder.markCompletedCalls).toHaveLength(1);
    expect(out.receipt.effect_evidence).toBe('committed');
  });
});

describe('SC04-AC05 — perda de posse não produz receipt', () => {
  it('abort durante o handler → `ownership_lost`, sem receipt e sem resultado', async () => {
    const controller = new AbortController();
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:token_mismatch'));

    const out = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchToolDurable(
        { tool: 'sc04_safe', args: {}, ctx },
        mkControl({
          classification: {
            side_effect: 'read',
            effect_class: 'abort_safe',
            sensitive: false,
            legacy_irreversible_invoked: false,
          },
        }),
      ),
    );

    // Nenhum receipt existe para um turno que deixou de ser dono — e o
    // resultado do handler NÃO viaja junto.
    expect(out).toEqual({ kind: 'ownership_lost' });
    expect(JSON.stringify(out)).not.toContain('from":"handler');
    expect(recorder.markCompletedCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O GATEWAY no caminho durável (§5.3.2)
// ─────────────────────────────────────────────────────────────────────────────
//
// As suítes acima medem o CORPO do despacho. Esta mede a OUTRA metade da
// costura: `createEngineToolGateway` quando os hooks duráveis estão ligados.
//
// Os `deps` são todos dublês — é o contrato do módulo (ele é puro fora das
// deps, por decisão declarada no próprio arquivo) —, e é isso que permite
// observar o que o gateway ENTREGA ao dispatcher e o que ele GRAVA a partir do
// receipt. As afirmações são sobre a costura:
//
//  1. Os hooks recebem `call_id`/`call_ordinal`/`dispatch_token`/classificação
//     do journal, e o `reservation_token` que chega ao marcador é o REAL da
//     reserva — não um `res-<call_id>` inventado no wrapper.
//  2. O fence da linha é uma CORRENTE: a versão que cada transição exige é a
//     que a anterior devolveu (uma aprovação registrada no meio não quebra o
//     marcador).
//  3. `identity_conflict` com o MESMO `payload_hash` é virada de bucket e adota
//     a identidade CONGELADA; com payload diferente é recusa.
//  4. O motor recebe a PROJEÇÃO (`result_for_engine`) e o journal recebe o
//     receipt com hash canônico; `effect_evidence: 'unknown'` liquida como
//     `effect_unknown`, nunca como `denied`.

type LedgerDoGateway = {
  controles: Array<Record<string, unknown>>;
  settles: Array<Record<string, unknown>>;
  marcadores: Array<Record<string, unknown>>;
  aprovacoes: Array<Record<string, unknown>>;
  freezes: Array<Record<string, unknown>>;
  freezeResult: FreezeIdentityResult;
  /**
   * O que o repo responde ao hook de congelamento quando ele NÃO está verde.
   *
   * `bucket` usa o MESMO `payload_hash` que o corpo propôs — é literalmente o
   * que uma virada de janela faz: a chave muda, a intenção não. `intencao` usa
   * um hash diferente, que é o caso em que a recusa tem de valer.
   */
  conflito: 'nenhum' | 'bucket' | 'intencao';
  /** Mensagem do hook que recusou, quando recusou (o corpo devolve `journal_unavailable`). */
  hookRecusou: string | null;
  desfecho: DurableDispatchResultV1;
};

const ledger: LedgerDoGateway = {
  controles: [],
  settles: [],
  marcadores: [],
  aprovacoes: [],
  freezes: [],
  conflito: 'nenhum',
  hookRecusou: null,
  freezeResult: {
    ok: true,
    frozen: true,
    key: 'K-congelada',
    payload_hash: 'v2:hash-real',
    row_version: 8,
  },
  desfecho: { kind: 'settled', receipt: null as never },
};

function receiptFalso(over: Partial<ToolReceiptV1> = {}): ToolReceiptV1 {
  return {
    call_id: 'call-gw-1',
    ordinal: 0,
    name: 'sc04_write',
    result: { protegido: 'path/interno.pdf' },
    result_for_engine: { tipo: 'extrato' },
    status: 'success',
    side_effect: 'write',
    effect_class: 'non_interruptible',
    legacy_irreversible_invoked: false,
    effect_evidence: 'committed',
    sensitive: false,
    started_at: '2026-09-26T12:00:00.000Z',
    finished_at: '2026-09-26T12:00:01.000Z',
    summary: {
      tool_call_id: 'call-gw-1',
      tool_name: 'sc04_write',
      status: 'success',
      side_effect: 'write',
      result_summary: 'ok',
      occurred_at: '2026-09-26T12:00:01.000Z',
    },
    approval: null,
    pending_question_id: null,
    report: null,
    ...over,
  };
}

const CLASSIFICACAO_GW: ToolClassification = {
  side_effect: 'write',
  effect_class: 'non_interruptible',
  sensitive: false,
  legacy_irreversible_invoked: false,
};

/**
 * O control devolvido ao gateway é usado como o CORPO do dispatcher usa:
 * congelar identidade e, imediatamente antes do handler, marcar o início. A
 * ordem importa — é ela que produz a versão que o segundo hook exige.
 */
function gatewayComDurable(
  over: Partial<ToolGatewayDepsV1> = {},
): (call: EngineToolCallV1) => Promise<EngineToolReplyV1> {
  const deps: ToolGatewayDepsV1 = {
    decide: () => ({ kind: 'admit', tool: {} as never }),
    classify: () => CLASSIFICACAO_GW,
    admit: async (input) => ({
      ok: true,
      kind: 'admitted',
      call_id: input.call.call_id,
      ordinal: 0,
    }),
    markDispatching: async () => ({ ok: true, dispatch_token: 'tok-dispatch', row_version: 7 }),
    freezeToolIdentity: async (input) => {
      ledger.freezes.push(input as unknown as Record<string, unknown>);
      /**
       * NO caminho durável há UM único congelamento, e é o do CORPO, com a
       * chave candidata (`computeIdempotencyKey`, com bucket). O `(4a)` do
       * gateway — que congelava `call_id` antes do corpo — só existe no caminho
       * LEGADO: o dublê abaixo recusaria essa segunda passagem, que é
       * exatamente o defeito de costura que a suíte de banco prende ponta a
       * ponta (`tests/integration/refinement-sc04-real-db.spec.ts`).
       */
      if (ledger.conflito === 'bucket') {
        return {
          ok: false,
          reason: 'identity_conflict',
          current_idempotency_key: 'K-congelada',
          current_idempotency_payload_hash: input.idempotency_payload_hash,
        };
      }
      if (ledger.conflito === 'intencao') {
        return {
          ok: false,
          reason: 'identity_conflict',
          current_idempotency_key: 'K-congelada',
          current_idempotency_payload_hash: 'v2:OUTRO-payload',
        };
      }
      return ledger.freezeResult;
    },
    markToolHandlerStarted: async (input) => {
      ledger.marcadores.push(input as unknown as Record<string, unknown>);
      return { ok: true, effect_evidence: 'none' as const, row_version: 9 };
    },
    settle: async (input) => {
      ledger.settles.push(input as unknown as Record<string, unknown>);
      return { ok: true };
    },
    dispatch: async () => ({ ok: true }),
    buildToolContext: async () => ctx as unknown as ToolContext,
    dispatchDurable: async (input, control) => {
      ledger.controles.push(control as unknown as Record<string, unknown>);
      /**
       * O dublê faz o que o CORPO faz: chama os hooks na ordem real e, quando
       * um deles recusa, devolve `journal_unavailable` em vez de deixar a
       * exceção subir. Esse `catch` NÃO é conveniência de teste — é o contrato
       * do dispatcher (`dispatchToolDurable` nunca lança por falha de journal),
       * e sem ele o teste mediria uma exceção que em produção não existe.
       */
      try {
        await control.freezeIdentity({
          key: 'K-candidata',
          payload_hash: 'v2:hash-real',
          normalized_args: input.args,
        });
        await control.beforeHandler({
          reservation_token: 'reserva-real-do-corpo',
          approval_request_id: null,
          approval_claim_token: null,
        });
      } catch (err) {
        ledger.hookRecusou = (err as Error).message;
        return { kind: 'journal_unavailable', handler_may_have_started: false };
      }
      return ledger.desfecho;
    },
    recordToolApproval: async (input) => {
      ledger.aprovacoes.push(input as unknown as Record<string, unknown>);
      return { ok: true, row_version: 8 };
    },
    ...over,
  };
  return createEngineToolGateway(
    {
      run_id: 'run-gw',
      turn_id: 'turno-gw',
      origin_claim_token: 'claim-gw',
      request_id: 'req-gw',
    },
    deps,
  );
}

function chamadaGw(over: Partial<EngineToolCallV1> = {}): EngineToolCallV1 {
  return {
    version: 1,
    run_id: 'run-gw',
    call_id: 'call-gw-1',
    ordinal: 0,
    iteration: 1,
    name: 'sc04_write',
    args: { texto: 'oi' },
    ...over,
  };
}

describe('SC04-gateway — o caminho durável ligado pelos hooks', () => {
  beforeEach(() => {
    ledger.controles = [];
    ledger.settles = [];
    ledger.marcadores = [];
    ledger.aprovacoes = [];
    ledger.freezes = [];
    ledger.conflito = 'nenhum';
    ledger.hookRecusou = null;
    ledger.freezeResult = {
      ok: true,
      frozen: true,
      key: 'K-congelada',
      payload_hash: 'v2:hash-real',
      row_version: 8,
    };
    ledger.desfecho = { kind: 'settled', receipt: receiptFalso() };
  });

  it('entrega ao corpo `call_id`/`ordinal`/`dispatch_token` e a classificação CONGELADA', async () => {
    const out = await gatewayComDurable()(chamadaGw());

    expect(ledger.controles).toHaveLength(1);
    expect(ledger.controles[0]).toMatchObject({
      call_id: 'call-gw-1',
      call_ordinal: 0,
      dispatch_token: 'tok-dispatch',
      classification: CLASSIFICACAO_GW,
    });

    // O marcador recebeu o token da RESERVA (o do corpo), nunca `res-<call_id>`.
    expect(ledger.marcadores).toHaveLength(1);
    expect(ledger.marcadores[0]).toMatchObject({
      reservation_token: 'reserva-real-do-corpo',
      dispatch_token: 'tok-dispatch',
      // A versão exigida é a que o congelamento devolveu (8), não a da admissão
      // (0) nem um literal: o fence é corrente.
      expected_row_version: 8,
    });

    // E o motor recebe a PROJEÇÃO, não o resultado protegido.
    expect(out).toMatchObject({
      kind: 'result',
      call_id: 'call-gw-1',
      result: { tipo: 'extrato' },
      is_error: false,
    });
    expect(JSON.stringify(out)).not.toContain('path/interno.pdf');
  });

  it('liquida `completed` com o receipt e o hash do conteúdo canônico', async () => {
    await gatewayComDurable()(chamadaGw());

    expect(ledger.settles).toHaveLength(1);
    const settle = ledger.settles[0]!;
    expect(settle).toMatchObject({
      call_id: 'call-gw-1',
      dispatch_token: 'tok-dispatch',
      // A versão do marcador (9), devolvida pelo próprio hook.
      expected_row_version: 9,
    });
    const outcome = settle.outcome as {
      kind: string;
      result: unknown;
      receipt: { json: unknown; hash: string };
    };
    expect(outcome.kind).toBe('completed');
    expect(outcome.result).toEqual({ protegido: 'path/interno.pdf' });
    expect(outcome.receipt.hash).toBe(canonicalDigest(outcome.receipt.json));
    expect(outcome.receipt.json).toMatchObject({
      call_id: 'call-gw-1',
      effect_evidence: 'committed',
    });
  });

  it('`effect_evidence: unknown` liquida como `effect_unknown`, nunca como `denied`', async () => {
    ledger.desfecho = {
      kind: 'settled',
      receipt: receiptFalso({ status: 'error', effect_evidence: 'unknown' }),
    };

    const out = await gatewayComDurable()(chamadaGw());

    const outcome = ledger.settles[0]!.outcome as {
      kind: string;
      result: unknown;
      receipt?: { json: unknown; hash: string };
    };
    expect(outcome.kind).toBe('effect_unknown');
    // `denied` afirmaria "nada rodou" sobre um efeito que pode ter acontecido —
    // e a linha ficaria incoerente com o próprio receipt.
    expect(outcome.result).toEqual({ protegido: 'path/interno.pdf' });
    // O receipt acompanha o desfecho mesmo aqui: é dele que o REPLAY tira a
    // projeção (`result_for_engine`), em vez de devolver o `result_json`
    // protegido ao motor. Sem ele, `effect_unknown` não teria de onde projetar.
    expect(outcome.receipt?.json).toMatchObject({
      call_id: 'call-gw-1',
      effect_evidence: 'unknown',
    });
    expect(outcome.receipt?.hash).toBe(canonicalDigest(outcome.receipt?.json));
    expect(out).toMatchObject({
      kind: 'result',
      is_error: true,
      result: { tipo: 'extrato' },
    });
    expect(JSON.stringify(out)).not.toContain('path/interno.pdf');
  });

  it('virada de BUCKET adota a identidade congelada; intenção diferente é recusa', async () => {
    // Mesma intenção (o MESMO `payload_hash` que o corpo propôs), chave
    // recalculada: é a virada de janela, e a identidade que vale é a gravada.
    ledger.conflito = 'bucket';
    const out = await gatewayComDurable()(chamadaGw());
    expect(out.kind).toBe('result');
    expect(ledger.settles).toHaveLength(1);
    // A candidata é a que o corpo propôs (`K-candidata`, no dublê) e a
    // persistida (`K-congelada`) é a que vale — sem a adoção, este despacho
    // nem chegaria ao marcador. UM único congelamento: o do corpo.
    expect(ledger.freezes.map((f) => f['idempotency_key'])).toEqual(['K-candidata']);
    expect(ledger.marcadores).toHaveLength(1);

    // Payload divergente: o conflito é real e o despacho para, sem handler. O
    // que resta é a recusa — e, como ela PROVA que nada rodou
    // (`handler_may_have_started: false`), a call é encerrada como
    // `denied`/`none` para não ocupar a vaga sequencial do run.
    ledger.settles = [];
    ledger.conflito = 'intencao';
    const recusado = await gatewayComDurable()(chamadaGw());
    expect(recusado).toEqual({
      kind: 'refused',
      call_id: 'call-gw-1',
      code: 'run_not_authorized',
    });
    // O motivo TIPADO do repo viaja na mensagem do hook: é com ele que quem for
    // reconciliar separa "a intenção mudou" de "o journal recusou a versão".
    expect(ledger.hookRecusou).toBe('freeze_identity:identity_conflict');
    expect(ledger.settles).toHaveLength(1);
    expect(ledger.settles[0]!.outcome).toMatchObject({ kind: 'denied' });
  });

  it('`journal_unavailable` com o handler já começado NÃO liquida e devolve `effect_unknown`', async () => {
    ledger.desfecho = { kind: 'journal_unavailable', handler_may_have_started: true };

    const out = await gatewayComDurable()(chamadaGw());

    expect(out).toEqual({ kind: 'refused', call_id: 'call-gw-1', code: 'effect_unknown' });
    // Sem receipt não existe desfecho para gravar: liquidar aqui seria inventar.
    expect(ledger.settles).toHaveLength(0);
  });

  it('`journal_unavailable` ANTES do handler encerra a call como `denied` (a vaga sequencial não fica presa)', async () => {
    // Recusa tipada do hook do marcador: o dublê do corpo devolve
    // `handler_may_have_started: false` — nada rodou, e isso é PROVADO.
    ledger.conflito = 'intencao';
    const out = await gatewayComDurable()(chamadaGw());

    expect(out).toEqual({ kind: 'refused', call_id: 'call-gw-1', code: 'run_not_authorized' });
    // Sem encerrar, a linha ficaria em `dispatching` — o estado que OCUPA a
    // vaga sequencial do run — e o run nunca mais andaria.
    expect(ledger.settles).toHaveLength(1);
    const settle = ledger.settles[0]!;
    expect(settle).toMatchObject({
      call_id: 'call-gw-1',
      dispatch_token: 'tok-dispatch',
      outcome: { kind: 'denied' },
    });
  });

  it('`ownership_lost` devolve recusa de autorização, sem liquidar', async () => {
    ledger.desfecho = { kind: 'ownership_lost' };

    const out = await gatewayComDurable()(chamadaGw());

    expect(out).toEqual({ kind: 'refused', call_id: 'call-gw-1', code: 'run_not_authorized' });
    expect(ledger.settles).toHaveLength(0);
  });

  /**
   * REPLAY pelo ramo `receipt` do gateway (§5.3.2/AC02/AC05, SPEC-L1403/T26).
   *
   * O `admit` de uma call já conciliada devolve o `result_json` do journal — no
   * caminho durável, o resultado PROTEGIDO do backend — e, ao lado, a projeção
   * que ficou no receipt. O motor tem de receber a SEGUNDA em toda entrega
   * repetida: antes, o replay devolvia o `result_json` e o callback repetido do
   * motor recebia de volta o caminho interno do arquivo.
   */
  it('replay: `admit` conciliado devolve a PROJEÇÃO do receipt, não o `result_json` protegido', async () => {
    const out = await gatewayComDurable({
      admit: async (input: { call: EngineToolCallV1 }) => ({
        ok: true,
        kind: 'receipt',
        call_id: input.call.call_id,
        state: 'completed',
        result: { protegido: 'path/interno.pdf' },
        result_for_engine: { tipo: 'extrato' },
        receipt_status: 'success',
      }),
    })(chamadaGw());

    expect(out).toMatchObject({
      kind: 'result',
      call_id: 'call-gw-1',
      result: { tipo: 'extrato' },
      is_error: false,
    });
    expect(JSON.stringify(out)).not.toContain('path/interno.pdf');
    // Replay é LEITURA: nenhum handler, nenhuma liquidação, nenhum hook.
    expect(ledger.settles).toHaveLength(0);
    expect(ledger.controles).toHaveLength(0);
    expect(ledger.marcadores).toHaveLength(0);
  });

  it('replay de `denied` durável também entrega a projeção, com `is_error`', async () => {
    const out = await gatewayComDurable({
      admit: async (input: { call: EngineToolCallV1 }) => ({
        ok: true,
        kind: 'receipt',
        call_id: input.call.call_id,
        state: 'denied',
        result: { protegido: 'path/interno.pdf', error: 'falha simulada' },
        result_for_engine: { error: 'falha simulada' },
        receipt_status: 'error',
      }),
    })(chamadaGw());

    expect(out).toMatchObject({
      kind: 'result',
      result: { error: 'falha simulada' },
      is_error: true,
    });
    expect(JSON.stringify(out)).not.toContain('path/interno.pdf');
  });

  it('replay SEM receipt persistido (caminho legado) devolve o `result_json`, como sempre devolveu', async () => {
    // Nada de projeção persistida ⇒ a chave vem AUSENTE do `admit`. Trocar isso
    // mudaria a resposta de quem já depende do caminho legado.
    const out = await gatewayComDurable({
      admit: async (input: { call: EngineToolCallV1 }) => ({
        ok: true,
        kind: 'receipt',
        call_id: input.call.call_id,
        state: 'completed',
        result: { ok: true, eco: 'oi' },
      }),
    })(chamadaGw());

    expect(out).toMatchObject({
      kind: 'result',
      result: { ok: true, eco: 'oi' },
      is_error: false,
    });
    expect(ledger.settles).toHaveLength(0);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// FIM-ANEXO-SC04-GATEWAY