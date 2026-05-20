/**
 * P9b (Camada 2) — Integration shim for Decision Engine in the runtime hot path.
 *
 * Spec §12.2 + master invariante 14: the FEATURE_DECISION_ENGINE_V1 flag
 * controls only whether the Decision Engine V1 produces the DecisionPacket.
 * PEPs themselves run in BOTH paths (legacy wrapper + engine).
 *
 * Two exported entry points:
 *
 *  1. `runDecisionEngineIfEnabled(base, env, metrics?)` — DI-friendly version
 *     consumed by unit/integration tests and lower-level callers that wire
 *     their own deps. Engine error → skip_reason: 'engine_error' (no throw).
 *
 *  2. `runDecisionEngineForTurn(base)` — production hot-path wrapper used by
 *     agent/core.ts. Reads env vars from config singleton, instantiates a
 *     shared engine singleton wired with REAL production adapters
 *     (P8e/P9a/P9d/P9c), and enforces fail-closed semantics:
 *       • kill switch ON  → { engine_ran: false, skip_reason: 'kill_switch' }
 *       • flag OFF        → { engine_ran: false, skip_reason: 'flag_off' }
 *       • engine throws   →
 *           FEATURE_DECISION_ENGINE_ERROR_FALLBACK='legacy'
 *             → { engine_ran: false, skip_reason: 'engine_error' }
 *           FEATURE_DECISION_ENGINE_ERROR_FALLBACK='fail-closed' (default)
 *             → throws DecisionEngineFailClosedError (caller blocks the turn)
 *
 * `getDecisionEngine()` returns the process-lifetime singleton wired with
 * REAL production adapters (P8e/P9a/P9d/P9c). With FEATURE_DECISION_ENGINE_V1=true
 * this performs real policy + skill + DSL evaluation per spec §12.
 *
 * TODO(P8a #96): update `src/agent/react-loop.ts` to:
 *   1. build BaseContextPacket from incoming Mensagem + Pessoa + Conversa
 *   2. call `runDecisionEngineIfEnabled(base)`  (no env arg needed — uses singleton)
 *   3. if `result.block` present → handle blocked turn (escalate / template)
 *   4. otherwise pass `result.packet` to existing prompt/response pipeline
 */
import {
  createDecisionEngine,
  type CreateDecisionEngineEnv,
  type DecisionEngineResult,
} from './index.js';
import { isDecisionEngineV1Enabled } from '../feature-flags/decision-engine-flag.js';
import type { BaseContextPacket } from '../context-packet/types.js';
import type { MetricsClient } from './types.js';
import { createProductionDecisionEngineEnv } from './prod-env.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';

// ============================================================================
// Shared types
// ============================================================================

export interface RunDecisionEngineResult {
  /** True if the Decision Engine ran (flag ON + no error). */
  engine_ran: boolean;
  /** The DecisionEngineResult if the engine ran, otherwise undefined. */
  result?: DecisionEngineResult;
  /** Reason the engine did not run, when applicable. */
  skip_reason?: 'flag_off' | 'kill_switch' | 'engine_error';
}

/**
 * Thrown by `runDecisionEngineForTurn` when the engine errors and
 * FEATURE_DECISION_ENGINE_ERROR_FALLBACK is 'fail-closed' (default).
 *
 * Callers in agent/core.ts catch this and return a blocked response to the
 * user instead of proceeding to the LLM.
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
 * Wraps the engine in flag check + error-fallback per spec §12.3.
 *
 * - Kill switch ON → returns `{ engine_ran: false, skip_reason: 'flag_off' }`.
 * - Flag OFF → returns `{ engine_ran: false, skip_reason: 'flag_off' }`.
 * - Flag ON, engine succeeds → returns `{ engine_ran: true, result }`.
 * - Flag ON, engine throws unexpectedly → records metric, returns
 *   `{ engine_ran: false, skip_reason: 'engine_error' }` so caller can
 *   fall through to legacy path (which still runs PEPs via wrapper).
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
  const enabled = await isDecisionEngineV1Enabled(base.tenant_id);
  if (!enabled) {
    metrics?.increment('decision_engine.flag_off');
    return { engine_ran: false, skip_reason: 'flag_off' };
  }

  try {
    // Use the real production singleton when no override env is supplied.
    const engine = env ? createDecisionEngine(env) : getDecisionEngine();
    const result = await engine.run({ base });
    return { engine_ran: true, result };
  } catch (err) {
    metrics?.increment('decision_engine.error_fallback');
    // We log via the env.metrics if available; otherwise swallow silently
    // so the caller can fall back to legacy without surfacing the error.
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
 * Gate a turn through the Decision Engine before the LLM call.
 *
 * Reads FEATURE_DECISION_ENGINE_V1_KILL_SWITCH, FEATURE_DECISION_ENGINE_V1,
 * and FEATURE_DECISION_ENGINE_ERROR_FALLBACK from the config singleton (env.ts).
 *
 * Semantics:
 *  - kill_switch ON → skip (engine_ran: false, skip_reason: 'kill_switch')
 *  - flag OFF       → skip (engine_ran: false, skip_reason: 'flag_off')
 *  - engine OK      → { engine_ran: true, result }
 *  - engine error + fallback='legacy' → skip (engine_ran: false, skip_reason: 'engine_error')
 *  - engine error + fallback='fail-closed' → throws DecisionEngineFailClosedError
 */
export async function runDecisionEngineForTurn(
  base: BaseContextPacket,
): Promise<RunDecisionEngineResult> {
  // 1. Kill switch — highest precedence
  if (config.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH) {
    return { engine_ran: false, skip_reason: 'kill_switch' };
  }

  // 2. Feature flag
  if (!config.FEATURE_DECISION_ENGINE_V1) {
    return { engine_ran: false, skip_reason: 'flag_off' };
  }

  // 3. Run the engine
  try {
    const engine = getDecisionEngine();
    const result = await engine.run({ base });
    return { engine_ran: true, result };
  } catch (err) {
    logger.error(
      { err, tenant_id: base.tenant_id, trace_id: base.trace_id },
      'decision-engine error',
    );

    if (config.FEATURE_DECISION_ENGINE_ERROR_FALLBACK === 'legacy') {
      // Degrade silently: caller proceeds to legacy LLM path without engine output
      return { engine_ran: false, skip_reason: 'engine_error' };
    }

    // fail-closed (default): caller MUST handle as block
    throw new DecisionEngineFailClosedError(err, base.tenant_id, base.trace_id);
  }
}
