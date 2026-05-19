/**
 * P9b — Integration shim for Decision Engine in the runtime hot path.
 *
 * Spec §12.2 + master invariante 14: the FEATURE_DECISION_ENGINE_V1 flag
 * controls only whether the Decision Engine V1 produces the DecisionPacket.
 * PEPs themselves run in BOTH paths (legacy wrapper + engine).
 *
 * `runDecisionEngineIfEnabled` is the single entry point for callers
 * (today: nothing — when P8a #96 lands and `react-loop.ts` is wired to
 * build BaseContextPacket, that file will import this helper).
 *
 * Until then, the helper is exercised by integration tests and is ready
 * for plug-in.
 *
 * TODO(P8a #96): update `src/agent/react-loop.ts` to:
 *   1. build BaseContextPacket from incoming Mensagem + Pessoa + Conversa
 *   2. call `runDecisionEngineIfEnabled(base, env)`
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

export interface RunDecisionEngineResult {
  /** True if the Decision Engine ran (flag ON + no error). */
  engine_ran: boolean;
  /** The DecisionEngineResult if the engine ran, otherwise undefined. */
  result?: DecisionEngineResult;
  /** Reason the engine did not run, when applicable. */
  skip_reason?: 'flag_off' | 'engine_error';
}

/**
 * Wraps the engine in flag check + error-fallback per spec §12.3.
 *
 * - Flag OFF → returns `{ engine_ran: false, skip_reason: 'flag_off' }`.
 * - Flag ON, engine succeeds → returns `{ engine_ran: true, result }`.
 * - Flag ON, engine throws unexpectedly → records metric, returns
 *   `{ engine_ran: false, skip_reason: 'engine_error' }` so caller can
 *   fall through to legacy path (which still runs PEPs via wrapper).
 *
 * Note: budget exhaustion is NOT an unexpected error — the engine returns
 * a `fallback_applied` packet and `engine_ran: true`.
 */
export async function runDecisionEngineIfEnabled(
  base: BaseContextPacket,
  env: CreateDecisionEngineEnv,
  metrics?: MetricsClient,
): Promise<RunDecisionEngineResult> {
  const enabled = await isDecisionEngineV1Enabled(base.tenant_id);
  if (!enabled) {
    metrics?.increment('decision_engine.flag_off');
    return { engine_ran: false, skip_reason: 'flag_off' };
  }

  try {
    const engine = createDecisionEngine(env);
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
