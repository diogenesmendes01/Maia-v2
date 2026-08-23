/**
 * Issue #507 (achado da rodada 2 da revisão do dono) — a janela TOCTOU entre o
 * guard de posse do Decision Engine e o CONSUMO COM EFEITO do pacote.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `runDecisionEngineForTurn` conferia a posse ANTES de
 * `await traceTurnDecision(...)` e não depois. Com `FEATURE_RUNTIME_TRACE_V1`
 * ligado esse await é a gravação do envelope durável — outro trecho longo — e
 * a lease pode cair no meio dele. Duas saídas, as duas erradas:
 *
 *  - a gravação RESOLVE: a função devolvia `{ engine_ran: true, result }` sem
 *    nova conferência, e `src/agent/core.ts` executa na sequência os ramos
 *    `block` / `escalate` / `execute_skill` — inclusive RESPONDENDO ao usuário
 *    em nome da tentativa velha;
 *  - a gravação REJEITA: o erro subia cru, `src/agent/core.ts` reconhecia
 *    `MandatoryTraceEnvelopeError` e entrava no handler dele (`audit` +
 *    `failTurnRetryable`) — duas escritas num turno que já é de outro worker.
 *
 * ─── Por que o teste é assim ────────────────────────────────────────────────
 *
 * `traceTurnDecision` é um DUBLÊ DEFERIDO: ele devolve uma promise que este
 * arquivo controla. Só isso torna a janela — que em produção é um intervalo de
 * corrida — um PONTO DE PAUSA determinístico onde a posse é tomada.
 *
 * E a asserção não é "apareceu uma exceção". Um teste assim passa com o defeito
 * inteiro no lugar quando olha o lugar errado. Aqui existe `consumidos`: um
 * consumidor que MIMETIZA `src/agent/core.ts` — carimba `decision_packet`
 * quando recebe o pacote, e `mandatory_envelope_handler` quando cai no ramo
 * `instanceof MandatoryTraceEnvelopeError`. A prova é a lista VAZIA: nenhum
 * efeito posterior aconteceu.
 *
 * REAL aqui: `runDecisionEngineForTurn`, `runWithTurnExecution` +
 * `assertTurnOwnership` (o ALS e o `AbortSignal` de verdade), e as classes
 * `TurnOwnershipLostError` / `MandatoryTraceEnvelopeError` de produção — nada
 * de erro-sósia declarado no teste, senão o `instanceof` do core não estaria
 * sendo exercitado. DUBLÊ: o singleton do motor (`_overrideDecisionEngineSingleton`,
 * o seam que a própria produção oferece) e `traceTurnDecision`.
 *
 * Os CONTROLES (posse INTACTA) dão significado ao zero: com a posse viva o
 * pacote É consumido, e a rejeição do envelope CONTINUA emergindo como
 * `MandatoryTraceEnvelopeError` — o guard novo não pode ter virado um
 * engolidor de falha de evidência.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Só `traceTurnDecision` é dublado; `MandatoryTraceEnvelopeError` continua
 * sendo a classe REAL, que é o que o `instanceof` do consumidor observa.
 */
const traceTurnDecision = vi.fn();
vi.mock('@/observability/turn-trace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/observability/turn-trace.js')>();
  return { ...actual, traceTurnDecision };
});

const {
  runDecisionEngineForTurn,
  _resetDecisionEngineSingleton,
  _overrideDecisionEngineSingleton,
} = await import('@/runtime/decision/integration.js');
const { runWithTurnExecution, TurnOwnershipLostError } = await import(
  '@/runtime/turns/execution-context.js'
);
const { MandatoryTraceEnvelopeError } = await import('@/observability/turn-trace.js');

import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';
import type { DecisionEngineResult } from '@/runtime/decision/decision-engine.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function mkBase(): BaseContextPacket {
  return {
    trace_id: '11111111-2222-4333-8444-555555555555',
    tenant_id: 'tn_toctou',
    agent_id: 'ag_toctou',
    session_id: 'conv_toctou',
    conversation_id: 'conv_toctou',
    channel: { id: 'ch_wpp', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p_toctou', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: 'msg_toctou',
      content_hmac: '',
      received_at: new Date().toISOString(),
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
  };
}

/**
 * Um pacote que o core CONSOME COM EFEITO: `action_mode: 'escalate'` é o ramo
 * que responde ao usuário e conclui o turno como `blocked_by_policy`
 * (`src/agent/core.ts`). Se o packet vazar, o que vaza é isso.
 */
function mkPacket(): DecisionPacket {
  return {
    trace_id: '11111111-2222-4333-8444-555555555555',
    intent: { label: 'transfer', confidence: 0.9 },
    risk_profile: { level: 'high', reasons: [], requires_human_review: true },
    routing: { agent_id: 'ag_toctou', candidate_skill_ids: [] },
    action_mode: 'escalate',
    tool_permissions: { allowed_tools: [], blocked_tools: [], requires_confirmation: [] },
    context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: true },
    policy_decisions: [],
    rationale: 'escalate',
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Espera a condição virar verdadeira sem prender o event loop. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timeout esperando: ${label}`);
}

function mkCtx(signal: AbortSignal): TurnExecutionContext {
  return {
    tenant_id: 'tn_toctou',
    agent_id: 'ag_toctou',
    turn_id: 'turn_toctou',
    attempt: 1,
    claim_token: 'tok_toctou',
    worker_id: 'w_toctou',
    deadline: new Date(Date.now() + 60_000),
    signal,
  };
}

/** Motor dublê: devolve o pacote de escalation, sem I/O. */
function injectEngine(run?: () => Promise<DecisionEngineResult>) {
  const fake = {
    run: vi.fn(run ?? (async () => ({ packet: mkPacket() }))),
  } as unknown as ReturnType<typeof import('@/runtime/decision/index.js').getDecisionEngine>;
  _overrideDecisionEngineSingleton(fake);
  return fake;
}

// ─── O consumidor que MIMETIZA src/agent/core.ts ────────────────────────────

const consumidos: string[] = [];

/**
 * Os DOIS pontos de consumo com efeito nomeados no achado, na mesma ordem e com
 * o mesmo discriminador que `src/agent/core.ts` usa:
 *
 *  - `deResult.engine_ran && deResult.result` → ramos block/escalate/execute_skill;
 *  - `err instanceof MandatoryTraceEnvelopeError` → audit + failTurnRetryable.
 *
 * Nenhum dos dois pode acender quando a posse caiu.
 */
async function consumirComoOCore(base: BaseContextPacket): Promise<void> {
  try {
    const deResult = await runDecisionEngineForTurn(base);
    if (deResult.engine_ran && deResult.result) consumidos.push('decision_packet');
  } catch (err) {
    if (err instanceof MandatoryTraceEnvelopeError) consumidos.push('mandatory_envelope_handler');
    throw err;
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('#507 — Decision Engine: a posse é conferida DEPOIS do await do trace', () => {
  beforeEach(() => {
    consumidos.length = 0;
    traceTurnDecision.mockReset();
    _resetDecisionEngineSingleton();
  });

  afterEach(() => {
    _resetDecisionEngineSingleton();
  });

  it('trace RESOLVE depois do abort: emerge TurnOwnershipLostError e o packet NÃO é consumido', async () => {
    injectEngine();
    const d = deferred<null>();
    traceTurnDecision.mockImplementation(() => d.promise);

    const ac = new AbortController();
    const corrida = runWithTurnExecution(mkCtx(ac.signal), () => consumirComoOCore(mkBase()));
    const capturada = corrida.catch((e: unknown) => e);

    // A janela: o envelope está EM VOO e a lease cai agora.
    await until(() => traceTurnDecision.mock.calls.length === 1, 'traceTurnDecision em voo');
    ac.abort();
    d.resolve(null); // a gravação foi bem-sucedida — e mesmo assim não vale nada

    const err = await capturada;
    // A asserção PRINCIPAL vem primeiro: o que o achado descreve é o EFEITO,
    // não a exceção. Sem o guard, `consumidos` traz `decision_packet` — e é
    // essa a linha que tem de ficar vermelha.
    expect(consumidos, 'nenhum efeito posterior pode ter acontecido').toEqual([]);
    expect(err, 'a gravação que resolve depois do abort não pode devolver o packet').toBeInstanceOf(
      TurnOwnershipLostError,
    );
    expect((err as InstanceType<typeof TurnOwnershipLostError>).boundary).toBe('decision_engine');
  });

  it('trace REJEITA depois do abort: emerge TurnOwnershipLostError, não o handler de envelope', async () => {
    injectEngine();
    const d = deferred<null>();
    traceTurnDecision.mockImplementation(() => d.promise);

    const ac = new AbortController();
    const corrida = runWithTurnExecution(mkCtx(ac.signal), () => consumirComoOCore(mkBase()));
    const capturada = corrida.catch((e: unknown) => e);

    await until(() => traceTurnDecision.mock.calls.length === 1, 'traceTurnDecision em voo');
    ac.abort();
    d.reject(new MandatoryTraceEnvelopeError(new Error('db down'), 'tn_toctou', 'high'));

    const err = await capturada;
    expect(
      consumidos,
      'o handler de MandatoryTraceEnvelopeError auditaria/falharia um turno alheio',
    ).toEqual([]);
    expect(
      err,
      'a falha do envelope depois do abort tem de ser reclassificada como perda de posse',
    ).toBeInstanceOf(TurnOwnershipLostError);
    expect((err as InstanceType<typeof TurnOwnershipLostError>).boundary).toBe('decision_engine');
  });

  it('abort ANTES do trace: o envelope durável nem chega a ser escrito', async () => {
    // O motor resolve DEPOIS do abort — a janela do guard que já existia.
    const ac = new AbortController();
    injectEngine(async () => {
      ac.abort();
      return { packet: mkPacket() };
    });
    traceTurnDecision.mockResolvedValue(null);

    const err = await runWithTurnExecution(mkCtx(ac.signal), () =>
      consumirComoOCore(mkBase()),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnOwnershipLostError);
    expect(
      traceTurnDecision,
      'o envelope é WRITE: sem posse ele não pode nem ser tentado',
    ).not.toHaveBeenCalled();
    expect(consumidos).toEqual([]);
  });

  it('CONTROLE (posse viva, trace resolve): o packet É consumido', async () => {
    injectEngine();
    traceTurnDecision.mockResolvedValue(null);

    const ac = new AbortController();
    await runWithTurnExecution(mkCtx(ac.signal), () => consumirComoOCore(mkBase()));

    expect(traceTurnDecision).toHaveBeenCalledOnce();
    expect(consumidos, 'com posse o pipeline segue — é isto que dá sentido ao zero acima').toEqual([
      'decision_packet',
    ]);
  });

  it('CONTROLE (posse viva, trace rejeita): o MandatoryTraceEnvelopeError ORIGINAL emerge', async () => {
    injectEngine();
    const original = new MandatoryTraceEnvelopeError(new Error('db down'), 'tn_toctou', 'high');
    traceTurnDecision.mockRejectedValue(original);

    const ac = new AbortController();
    const err = await runWithTurnExecution(mkCtx(ac.signal), () =>
      consumirComoOCore(mkBase()),
    ).catch((e: unknown) => e);

    expect(err, 'o guard novo não pode engolir nem re-embrulhar falha de evidência').toBe(original);
    expect(consumidos).toEqual(['mandatory_envelope_handler']);
  });
});
