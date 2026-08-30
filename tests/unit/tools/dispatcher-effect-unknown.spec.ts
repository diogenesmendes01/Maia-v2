/**
 * Issue #507 §Tools — o que o dispatcher DIZ quando o cancelamento chega tarde
 * demais, e o que ele faz com o resultado que chegou depois.
 *
 * ─── O vão que esta suíte fecha ─────────────────────────────────────────────
 *
 * A #504 entregou dois guards de POSSE: um na primeira linha do dispatcher e
 * outro imediatamente antes do handler. Os dois respondem à mesma pergunta —
 * "ainda posso COMEÇAR?" — e a resposta "não" é limpa: nada rodou.
 *
 * O que ninguém respondia é a pergunta seguinte: e quando o sinal cai DEPOIS,
 * com o handler no meio (ou já terminado)? Até aqui o dispatcher seguia em
 * frente — completava a reserva de idempotência, gravava o outbox, auditava
 * como sucesso e DEVOLVIA o resultado ao ReAct. Ou seja: um turno que já não
 * era nosso mutando estado e podendo disparar outbound, com o rastro dizendo
 * que deu tudo certo.
 *
 * As três afirmações desta suíte:
 *
 *   1. o resultado é DESCARTADO — nunca volta ao turno, em nenhuma classe;
 *   2. `abort_safe` responde `turn_ownership_lost` e ABANDONA a reserva (não há
 *      efeito a proteger, e marcá-la 'failed' negaria serviço ao worker que TEM
 *      a posse);
 *   3. as outras três respondem `effect_unknown`, marcam a reserva 'failed'
 *      (é assim que "nunca automaticamente retryable" vira comportamento do
 *      ledger, e não só texto), auditam `tool_effect_unknown` com a estratégia
 *      de reconciliação, e NUNCA devolvem `retryable: true`.
 *
 * ─── Por que unit, e o que o unit pode provar ───────────────────────────────
 *
 * O sinal é REAL (um `AbortController` de verdade, propagado pelo mesmo
 * `AsyncLocalStorage` de produção via `runWithTurnExecution`), e o momento do
 * abort é escolhido de dentro do handler — que é o instante que interessa. O
 * que é falso aqui é só o ledger de idempotência, para que cada transição possa
 * ser observada isoladamente. A perda de lease pelo mecanismo REAL (claim SQL →
 * takeover → heartbeat) está na suíte de integração irmã,
 * `tests/integration/turn-effect-unknown-real-db.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recorder } = vi.hoisted(() => ({
  recorder: {
    tryReserveCalls: [] as unknown[],
    markCompletedCalls: [] as unknown[],
    releaseReservationCalls: [] as Array<{ key: string; reservation_token: string }>,
    abandonReservationCalls: [] as Array<{ key: string; reservation_token: string }>,
    auditCalls: [] as Array<{ acao: string; metadata?: Record<string, unknown> }>,
    grantLookups: 0,
    handlerCalls: 0,
    /** Chamado DE DENTRO do handler, no meio do trabalho. */
    duranteOHandler: (() => {}) as () => void,
    handlerResult: { ok: true, from: 'handler' } as unknown,
    handlerThrows: false,
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async (input: unknown) => {
      recorder.tryReserveCalls.push(input);
      return {
        was_inserted: true,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: 'token-1',
      };
    }),
    lookup: vi.fn(async () => null),
    waitForCompletion: vi.fn(async () => ({ status: 'timeout' })),
    markCompleted: vi.fn(async (input: unknown) => {
      recorder.markCompletedCalls.push(input);
      return true;
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
    markCompletedWithEffect: vi.fn(async (input: unknown) => {
      recorder.markCompletedCalls.push(input);
      return true;
    }),
  },
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => {
      recorder.grantLookups += 1;
      return {
        granted_packs: [],
        granted_tools: ['safe_tool', 'writer_tool', 'compensable_tool'],
        denied_tools: [],
      };
    }),
  },
}));

vi.mock('@/governance/audit.js', () => ({
  audit: vi.fn(async (row: { acao: string; metadata?: Record<string, unknown> }) => {
    recorder.auditCalls.push(row);
  }),
}));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/governance/idempotency.js', () => ({
  computeIdempotencyKey: vi.fn(() => 'chave-1'),
  computePayloadHash: vi.fn(() => 'hash-1'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual =
    await vi.importActual<typeof import('@/governance/permissions.js')>(
      '@/governance/permissions.js',
    );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

/**
 * Três tools sintéticas, uma por comportamento de cancelamento. Declaram
 * `effect_class` como qualquer tool real declara — é o campo que o registro
 * exige e que o dispatcher lê.
 */
const { tools } = vi.hoisted(() => {
  const passthrough = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
  const mk = (name: string, effect_class: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: name,
    input_schema: passthrough,
    output_schema: passthrough,
    required_actions: [],
    side_effect: effect_class === 'abort_safe' ? 'read' : 'write',
    effect_class,
    redis_required: false,
    operation_type: 'create',
    audit_action: 'fact_saved',
    feature_flag: undefined,
    handler: async () => {
      recorder.handlerCalls += 1;
      // O ponto em que o teste escolhe o INSTANTE do cancelamento: dentro do
      // handler, com o trabalho já em curso.
      recorder.duranteOHandler();
      if (recorder.handlerThrows) throw new Error('handler explodiu');
      return recorder.handlerResult;
    },
    ...extra,
  });
  return {
    tools: {
      safe_tool: mk('safe_tool', 'abort_safe'),
      writer_tool: mk('writer_tool', 'non_interruptible'),
      compensable_tool: mk('compensable_tool', 'compensatable', {
        compensated_by: 'writer_tool',
      }),
    },
  };
});

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: tools,
  isToolEnabled: () => true,
}));

import { dispatchTool } from '@/tools/_dispatcher.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

const ctx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

/** Um contexto de tentativa com sinal REAL e prazo controlável. */
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

beforeEach(() => {
  vi.clearAllMocks();
  recorder.tryReserveCalls = [];
  recorder.markCompletedCalls = [];
  recorder.releaseReservationCalls = [];
  recorder.abandonReservationCalls = [];
  recorder.auditCalls = [];
  recorder.grantLookups = 0;
  recorder.handlerCalls = 0;
  recorder.duranteOHandler = () => {};
  recorder.handlerResult = { ok: true, from: 'handler' };
  recorder.handlerThrows = false;
});

describe('#507 — CONTROLE: sem cancelamento, nada muda', () => {
  it('a tentativa viva completa a reserva e devolve o resultado do handler', async () => {
    const controller = new AbortController();
    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );
    expect(recorder.handlerCalls).toBe(1);
    expect(recorder.markCompletedCalls).toHaveLength(1);
    expect(result).toEqual({ ok: true, from: 'handler' });
    expect(recorder.auditCalls.map((a) => a.acao)).not.toContain('tool_effect_unknown');
  });
});

describe('#507 — cancelamento DURANTE o handler de uma tool `abort_safe`', () => {
  it('devolve `turn_ownership_lost`, ABANDONA a reserva e descarta o resultado', async () => {
    const controller = new AbortController();
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:token_mismatch'));

    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'safe_tool', args: {}, ctx }),
    );

    expect(recorder.handlerCalls).toBe(1);
    expect(result).toEqual({ error: 'turn_ownership_lost', details: { tool: 'safe_tool' } });
    // A classe DECLARA que não há efeito: a reserva é apagada, não marcada
    // terminal — 'failed' faria o dono legítimo receber `idempotency_prior_failed`
    // por uma execução que não deixou nada.
    expect(recorder.abandonReservationCalls).toEqual([
      { key: 'chave-1', reservation_token: 'token-1' },
    ]);
    expect(recorder.releaseReservationCalls).toEqual([]);
    expect(recorder.markCompletedCalls).toEqual([]);
    // Sem efeito possível, não há o que reconciliar.
    expect(recorder.auditCalls.map((a) => a.acao)).not.toContain('tool_effect_unknown');
  });
});

describe('#507 — cancelamento DURANTE o handler de uma tool com efeito possível', () => {
  it('`non_interruptible` → `effect_unknown`, `retryable: false`, reconciliação humana', async () => {
    const controller = new AbortController();
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:token_mismatch'));

    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );

    expect(result).toMatchObject({
      error: 'effect_unknown',
      details: {
        tool: 'writer_tool',
        effect_class: 'non_interruptible',
        retryable: false,
        reconciliation: 'manual_reconciliation',
      },
    });
    // O resultado do handler NÃO volta ao turno.
    expect(result).not.toMatchObject({ ok: true });
    // 'failed' e não abandono: um efeito pode existir, então a MESMA chave deve
    // falhar rápido em vez de reexecutar sozinha.
    expect(recorder.releaseReservationCalls).toEqual([
      { key: 'chave-1', reservation_token: 'token-1' },
    ]);
    expect(recorder.abandonReservationCalls).toEqual([]);
    expect(recorder.markCompletedCalls).toEqual([]);
  });

  it('audita `tool_effect_unknown` com a estratégia, a chave e o turno/tentativa', async () => {
    const controller = new AbortController();
    // Handler COOPERATIVO: percebe o abort e rejeita. A causa registrada é
    // `signal_aborted` — distinta do resultado tardio, e a distinção é o que
    // revela se a dependência subjacente de fato parou.
    recorder.handlerThrows = true;
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:token_mismatch'));

    await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'compensable_tool', args: {}, ctx }),
    );

    const row = recorder.auditCalls.find((a) => a.acao === 'tool_effect_unknown');
    expect(row, 'sem linha de auditoria não há reconciliação possível').toBeDefined();
    expect(row!.metadata).toMatchObject({
      tool: 'compensable_tool',
      effect_class: 'compensatable',
      reconciliation: 'compensate',
      compensated_by: 'writer_tool',
      retryable: false,
      cause: 'signal_aborted',
      idempotency_key: 'chave-1',
      turn_id: 'turno-1',
      attempt: 1,
    });
  });

  it('handler que LANÇA depois do abort não vira `execution_failed` genérico', async () => {
    // Um cancelamento deliberado contado como falha de plataforma polui o error
    // rate E some com a única distinção que importa: houve efeito?
    const controller = new AbortController();
    recorder.handlerThrows = true;
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:expired'));

    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );

    expect(result).toMatchObject({ error: 'effect_unknown' });
  });
});

describe('#507 — RESULTADO TARDIO: o handler terminou, mas o turno já não é nosso', () => {
  it('o resultado é descartado e a reserva não é completada', async () => {
    const controller = new AbortController();
    // O handler roda INTEIRO e RESOLVE — o trabalho foi feito e pago. O sinal
    // caiu no meio, então o que não pode acontecer é o resultado ser adotado.
    recorder.duranteOHandler = () => controller.abort(new Error('turn.lease_lost:token_mismatch'));
    recorder.handlerResult = { ok: true, tarde: true };

    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );

    expect(recorder.handlerCalls).toBe(1);
    expect(result).toMatchObject({ error: 'effect_unknown', details: { retryable: false } });
    expect(recorder.markCompletedCalls).toEqual([]);
    const row = recorder.auditCalls.find((a) => a.acao === 'tool_effect_unknown');
    expect(row!.metadata).toMatchObject({ cause: 'late_result_discarded' });
  });
});

describe('#507 — DEADLINE: o orçamento é checado antes da autorização e antes do handler', () => {
  it('prazo vencido recusa ANTES de consultar grant, aprovação e reserva', async () => {
    const controller = new AbortController();
    const result = await runWithTurnExecution(turnContext(controller, daquiA(-1)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );

    expect(result).toMatchObject({
      error: 'turn_deadline_exceeded',
      details: { tool: 'writer_tool', effect_class: 'non_interruptible' },
    });
    expect(recorder.handlerCalls).toBe(0);
    // A recusa vem ANTES da autorização: nada de grant, nada de reserva, e
    // sobretudo nenhuma evidência de aprovação criada por um turno que não agiria.
    expect(recorder.grantLookups).toBe(0);
    expect(recorder.tryReserveCalls).toEqual([]);
  });

  it('prazo que sobra para uma leitura mas NÃO para um efeito: a leitura roda, o efeito não', async () => {
    // A distinção é a razão de o orçamento mínimo depender da CLASSE: quem pode
    // deixar efeito precisa também do tempo de PERSISTIR que ele aconteceu.
    const controller = new AbortController();
    const curto = daquiA(400);

    const leitura = await runWithTurnExecution(turnContext(controller, curto), () =>
      dispatchTool({ tool: 'safe_tool', args: {}, ctx }),
    );
    expect(leitura).toEqual({ ok: true, from: 'handler' });

    const escrita = await runWithTurnExecution(turnContext(controller, curto), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );
    expect(escrita).toMatchObject({ error: 'turn_deadline_exceeded' });
  });

  it('FORA de um turno reivindicado o guard é no-op (worker de agenda, playground)', async () => {
    // Sem contexto de tentativa não há prazo — e um guard que barrasse por
    // ausência derrubaria meio runtime sem provar nada.
    const result = await dispatchTool({ tool: 'writer_tool', args: {}, ctx });
    expect(result).toEqual({ ok: true, from: 'handler' });
  });
});

describe('#507 — SHUTDOWN e TAKEOVER produzem o mesmo veredito honesto', () => {
  // O sinal da tentativa é UM só: perda de lease por takeover, shutdown
  // gracioso (`release()`) e cancelamento administrativo abortam o mesmo
  // `AbortController`. O dispatcher não pergunta a causa — pergunta se pode
  // afirmar ausência de efeito. Estes casos fixam que a resposta não muda com
  // a origem do cancelamento.
  it.each([
    ['takeover', 'turn.lease_lost:token_mismatch'],
    ['shutdown gracioso', 'turn.lease_lost:released'],
    ['heartbeat morto', 'turn.lease_lost:heartbeat_failed'],
  ])('%s durante o handler → effect_unknown para tool com efeito possível', async (_nome, reason) => {
    const controller = new AbortController();
    recorder.duranteOHandler = () => controller.abort(new Error(reason));

    const result = await runWithTurnExecution(turnContext(controller, daquiA(60_000)), () =>
      dispatchTool({ tool: 'writer_tool', args: {}, ctx }),
    );

    expect(result).toMatchObject({ error: 'effect_unknown', details: { retryable: false } });
  });
});
