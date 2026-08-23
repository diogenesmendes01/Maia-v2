/**
 * P9b (Camada 2) — Integration shim for Decision Engine in the runtime hot path.
 *
 * P11: the Decision Engine is now ALWAYS ON — it runs on every turn and
 * produces the DecisionPacket before the LLM call. There is no legacy path to
 * fall back to anymore, so engine errors are always FAIL-CLOSED.
 *
 * Two exported entry points:
 *
 *  1. `runDecisionEngineIfEnabled(base, env, metrics?)` — DI-friendly version
 *     consumed by unit/integration tests and lower-level callers that wire
 *     their own deps. Engine error → skip_reason: 'engine_error' (no throw).
 *
 *  2. `runDecisionEngineForTurn(base)` — production hot-path wrapper used by
 *     agent/core.ts. Instantiates a shared engine singleton wired with REAL
 *     production adapters (P8e/P9a/P9d/P9c) and enforces fail-closed semantics:
 *       • engine throws → throws DecisionEngineFailClosedError (caller blocks the turn)
 *
 * `getDecisionEngine()` returns the process-lifetime singleton wired with
 * REAL production adapters (P8e/P9a/P9d/P9c). This performs real policy +
 * skill + DSL evaluation per spec §12.
 */
import {
  createDecisionEngine,
  type CreateDecisionEngineEnv,
  type DecisionEngineResult,
} from './index.js';
import type { BaseContextPacket } from '../context-packet/types.js';
import type { MetricsClient } from './types.js';
import { createProductionDecisionEngineEnv } from './prod-env.js';
import { logger } from '@/lib/logger.js';
import { traceTurnDecision } from '@/observability/turn-trace.js';
import {
  assertTurnOwnership,
  getTurnExecutionContext,
} from '@/runtime/turns/execution-context.js';

// ============================================================================
// Shared types
// ============================================================================

export interface RunDecisionEngineResult {
  /** True if the Decision Engine ran (no error). */
  engine_ran: boolean;
  /** The DecisionEngineResult if the engine ran, otherwise undefined. */
  result?: DecisionEngineResult;
  /**
   * Reason the engine did not run, when applicable. Only the DI-friendly
   * `runDecisionEngineIfEnabled` returns this (`engine_error`) so callers that
   * wire their own deps can degrade silently; the production wrapper
   * `runDecisionEngineForTurn` is fail-closed and throws instead.
   */
  skip_reason?: 'engine_error';
}

/**
 * Thrown by `runDecisionEngineForTurn` when the engine errors. The engine is
 * always-on with no legacy fallback, so an engine error fails closed: callers
 * in agent/core.ts catch this and return a blocked response to the user
 * instead of proceeding to the LLM.
 */
export class DecisionEngineFailClosedError extends Error {
  constructor(
    public readonly cause_error: unknown,
    public readonly tenant_id: string,
    public readonly trace_id: string,
  ) {
    super(
      `Decision Engine fail-closed: engine threw for tenant=${tenant_id} trace=${trace_id}`,
    );
    this.name = 'DecisionEngineFailClosedError';
  }
}

// ============================================================================
// DI-friendly shim (used by tests and integration specs)
// ============================================================================

/**
 * Runs the engine and reports the outcome (DI-friendly).
 *
 * - Engine succeeds → returns `{ engine_ran: true, result }`.
 * - Engine throws unexpectedly → records metric, returns
 *   `{ engine_ran: false, skip_reason: 'engine_error' }` so callers that wire
 *   their own deps can degrade silently without surfacing the error.
 *
 * Note: budget exhaustion is NOT an unexpected error — the engine returns
 * a `fallback_applied` packet and `engine_ran: true`.
 *
 * @param base  — The BaseContextPacket for the current turn.
 * @param env   — Optional override env (defaults to real production singleton).
 *               Pass a mock env in tests that don't want the real adapters.
 * @param metrics — Optional metrics client override.
 */
export async function runDecisionEngineIfEnabled(
  base: BaseContextPacket,
  env?: CreateDecisionEngineEnv,
  metrics?: MetricsClient,
): Promise<RunDecisionEngineResult> {
  try {
    // Use the real production singleton when no override env is supplied.
    const engine = env ? createDecisionEngine(env) : getDecisionEngine();
    const result = await engine.run({ base });
    return { engine_ran: true, result };
  } catch (err) {
    metrics?.increment('decision_engine.error_fallback');
    // We log via the env.metrics if available; otherwise swallow silently
    // so the caller can degrade without surfacing the error.
    void err;
    return { engine_ran: false, skip_reason: 'engine_error' };
  }
}

// ============================================================================
// Production hot-path singleton — wired with real production adapters (PR #154)
// ============================================================================

let _singleton: ReturnType<typeof createDecisionEngine> | null = null;

/**
 * Returns the process-lifetime Decision Engine singleton backed by real
 * production adapters (P8e/P9a/P9d/P9c).  Creates it on first call.
 *
 * The singleton is safe to reuse across requests because all per-request
 * state lives in BudgetTracker + PepAudit created inside `engine.run()`.
 *
 * @internal — exported for test spy injection; prefer `runDecisionEngineForTurn`.
 */
export function getDecisionEngine(): ReturnType<typeof createDecisionEngine> {
  if (_singleton) return _singleton;
  const env = createProductionDecisionEngineEnv();
  _singleton = createDecisionEngine(env);
  return _singleton;
}

/**
 * Reset the singleton — for test isolation ONLY. Do NOT call in production.
 * @internal
 */
export function _resetDecisionEngineSingleton(): void {
  _singleton = null;
}

/**
 * Override the singleton with a test double — for test isolation ONLY.
 * Call `_resetDecisionEngineSingleton()` in afterEach to restore.
 * @internal
 */
export function _overrideDecisionEngineSingleton(
  engine: ReturnType<typeof createDecisionEngine>,
): void {
  _singleton = engine;
}

// ============================================================================
// Production hot-path wrapper (used by agent/core.ts)
// ============================================================================

/**
 * Run a turn through the Decision Engine before the LLM call.
 *
 * P11: the engine is always-on with no legacy fallback. It runs on every turn;
 * an engine error fails closed.
 *
 * Semantics:
 *  - engine OK    → { engine_ran: true, result }
 *  - engine error → throws DecisionEngineFailClosedError (caller blocks the turn)
 */
export async function runDecisionEngineForTurn(
  base: BaseContextPacket,
): Promise<RunDecisionEngineResult> {
  const t0 = Date.now();
  let result: DecisionEngineResult;
  /**
   * Issue #507 (achado 2 da revisão do dono) — o Decision Engine roda ENTRE o
   * pending-gate e o ReAct e era chamado sem sinal, embora `engine.run` já
   * aceite `signal` e o repasse a todos os ports (classificador de intenção,
   * risk scorer, seletores, PEPs — `src/runtime/decision/decision-engine.ts`).
   *
   * Sem ele, perder a lease durante a avaliação não interrompia nada: o motor
   * ia até o próprio budget e o pacote resultante ainda podia virar BLOCK com
   * resposta ao usuário (`src/agent/core.ts`, ramo `block`) — efeito de um
   * turno alheio.
   */
  const turnSignal = getTurnExecutionContext()?.signal;
  try {
    const engine = getDecisionEngine();
    result = await engine.run({ base, ...(turnSignal ? { signal: turnSignal } : {}) });
  } catch (err) {
    // Issue #507 — a posse caiu DURANTE a avaliação. O erro é CONSEQUÊNCIA do
    // cancelamento, não falha do motor: tratá-lo como fail-closed faria o core
    // responder "Sistema indisponível" ao usuário e concluir/reagendar um turno
    // que pertence a outro worker. O guard vem ANTES do wrap, de propósito.
    assertTurnOwnership('decision_engine');
    logger.error(
      { err, tenant_id: base.tenant_id, trace_id: base.trace_id },
      'decision-engine error',
    );

    // fail-closed: caller MUST handle as block
    throw new DecisionEngineFailClosedError(err, base.tenant_id, base.trace_id);
  }

  // Issue #507 — GUARD DE BOUNDARY: o motor devolveu, mas a posse pode ter
  // caído durante o await. Nada abaixo pode acontecer sem posse — nem o
  // envelope durável de `traceTurnDecision` (é write), nem o consumo do pacote
  // pelo core (que pode bloquear o turno e RESPONDER ao usuário).
  assertTurnOwnership('decision_engine');

  // Issue #514 §4 — durable runtime trace, written AFTER the decision exists
  // and BEFORE the caller acts on it. This is the ordering P10b invariant 12
  // requires ("envelope precedes the side effect") and it is the single hook
  // that gives every turn an envelope without instrumenting each effect site.
  //
  // Gated OFF by default (`FEATURE_RUNTIME_TRACE_V1`) per the issue's canary
  // rollout, so this call is inert until an operator flips it.
  //
  // Deliberately OUTSIDE the try/catch above: a `traceTurnDecision` throw means
  // a MANDATORY envelope could not be written, which must fail the turn closed
  // — but it must not be misreported as "the engine crashed", so it surfaces as
  // itself rather than being wrapped in DecisionEngineFailClosedError. O
  // try/catch abaixo PRESERVA isso: ele só reclassifica perda de posse e
  // RELANÇA o erro original intacto, sem envolvê-lo em nada.
  try {
    await traceTurnDecision({
      base,
      packet: result.packet,
      block: result.block ?? null,
      evaluation_ms: Date.now() - t0,
    });
  } catch (err) {
    // Issue #507 (achado da rodada 2) — CAMINHO DE ERRO DO TRACE.
    //
    // Com `FEATURE_RUNTIME_TRACE_V1` ligado, a gravação do envelope durável é
    // outro await longo, e a lease pode cair no meio dele. Se o erro subisse
    // cru, `src/agent/core.ts` reconheceria `MandatoryTraceEnvelopeError` e
    // entraria no handler dele: `audit(...)` + `failTurnRetryable(...)` — duas
    // escritas no turno que JÁ É de outro worker, exatamente o desfecho que o
    // fencing existe para impedir.
    //
    // A ORDEM é o ponto: a posse é conferida PRIMEIRO. Se ela caiu, o que
    // emerge é `TurnOwnershipLostError` e o handler de envelope nunca roda; se
    // ela está intacta, o erro ORIGINAL segue — não engolimos falha de
    // evidência, que continua fail-closed no caller.
    assertTurnOwnership('decision_engine');
    throw err;
  }

  // Issue #507 (achado da rodada 2) — GUARD DEPOIS DO AWAIT DO TRACE.
  //
  // O guard que roda ANTES do trace cobre o intervalo até ele, não além. Sem
  // este, uma gravação de envelope que resolve depois do abort devolvia o
  // packet ao core, que pode executar `block`/`escalate`/`execute_skill` —
  // inclusive RESPONDER ao usuário — em nome da tentativa velha. Nenhum
  // consumo do pacote pode acontecer sem uma conferência imediatamente antes.
  assertTurnOwnership('decision_engine');

  return { engine_ran: true, result };
}
