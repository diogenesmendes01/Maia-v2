/**
 * Issue #514 §4 — connect the DURABLE runtime trace to the hot path.
 *
 * The P10b facade (`src/control-plane/runtime-trace/index.ts:94`) has existed
 * since #102 with envelope writer, outbox, redaction, HMAC and three workers —
 * but the issue's audit found no caller outside the module and its own tests.
 * This adapter is that caller.
 *
 * ## Where it hooks
 *
 * At the Decision Engine boundary (`runtime/decision/integration.ts`), i.e.
 * AFTER the decision is made and BEFORE any tool/outbound side effect runs.
 * That ordering is what satisfies P10b invariant 12 ("envelope precedes the
 * side effect") without having to instrument every individual effect site —
 * which also keeps the merge surface small while #503/#508 rewrite those
 * sites in parallel.
 *
 * ## Two trace systems, one boundary (issue §3)
 *
 * This is the COMPLIANCE trace: governed evidence, HMAC-signed, redacted,
 * never sampled. The operational/OTLP trace is a separate concern and may
 * sample read-only successes. Neither duplicates raw prompts.
 *
 * ## Rollout gate
 *
 * `FEATURE_RUNTIME_TRACE_V1` defaults OFF. That is issue §Rollout step 3
 * ("conectar runtime trace em canário") and it is also what keeps this commit
 * safe: with the flag off the hot path is byte-for-byte unchanged, and the
 * HMAC master secret (fail-closed in `lib/hmac.ts`) is not required in dev.
 *
 * ## Failure semantics
 *
 * - envelope REQUIRED (`side_effect_level >= medium`) → a write failure
 *   RETHROWS. The caller must abort the effect. Fail-loud is the point.
 * - envelope not required → failure is swallowed and counted. Observability
 *   must not break a turn that was never going to touch the world.
 */
import {
  trace,
  envelopeIsRequired,
  type Decision,
  type DecisionPacketStub,
  type ExecutionContextPacketStub,
  type SideEffectLevel,
  type TraceEnvelopeWritten,
} from '@/control-plane/runtime-trace/index.js';
import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';
import { logger } from '@/lib/logger.js';
import { counter, histogram } from './metrics.js';
import { METRIC } from './taxonomy.js';
import { correlationLogFields, tryGetCorrelation } from './correlation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `runtime_trace_envelopes.{trace_id,conversa_id,turno_id}` are UUID columns.
 * Anything else must not reach the INSERT — a malformed id would turn an
 * observability write into a turn-breaking DB error.
 */
function asUuidOrNull(v: string | null | undefined): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Read at call time so the flag can be flipped without a redeploy. */
export function runtimeTraceHotPathEnabled(): boolean {
  return process.env.FEATURE_RUNTIME_TRACE_V1 === 'true';
}

/**
 * Deterministic risk score from the engine's risk LEVEL.
 *
 * AGENTS.md §4.5: confidence/risk that feeds governance evidence is computed,
 * never model-declared. A fixed level→score table keeps the envelope
 * reproducible for the same decision.
 */
export function riskScoreFor(level: 'low' | 'medium' | 'high'): number {
  return level === 'high' ? 0.9 : level === 'medium' ? 0.6 : 0.25;
}

/**
 * Map the engine's outcome onto the side-effect level that decides whether the
 * envelope is MANDATORY.
 *
 * Rationale for the thresholds:
 *   - `call_tool` / `execute_skill` are the modes that can touch the world →
 *     at least `medium`, so the envelope is required before the effect.
 *   - a high-risk tool turn escalates to `high`.
 *   - a governance BLOCK is itself evidence worth a mandatory envelope: it is
 *     the record proving the platform refused.
 *   - pure `respond` / `ask_clarification` / `continue_workflow` are `low` →
 *     envelope is best-effort, matching §3 ("operational trace pode amostrar
 *     sucessos read-only").
 */
export function sideEffectLevelFor(
  packet: Pick<DecisionPacket, 'action_mode' | 'risk_profile'>,
  blocked: boolean,
): SideEffectLevel {
  if (blocked) return 'medium';
  switch (packet.action_mode) {
    case 'call_tool':
    case 'execute_skill':
      return packet.risk_profile.level === 'high' ? 'high' : 'medium';
    case 'escalate':
      return 'medium';
    default:
      return 'low';
  }
}

/** Map the engine's block verdict onto the P10b `Decision` enum. */
export function decisionFor(block?: { decision: 'block' | 'escalate' } | null): Decision {
  if (!block) return 'allow';
  return block.decision === 'escalate' ? 'escalate' : 'deny';
}

export interface TraceTurnDecisionInput {
  base: BaseContextPacket;
  packet: DecisionPacket;
  block?: { pep: string; policy_id: string; decision: 'block' | 'escalate'; reason: string } | null;
  /** Wall-clock the engine took, for `decision_meta.evaluation_ms`. */
  evaluation_ms?: number;
}

/**
 * Build the `DecisionPacketStub` the envelope signs.
 *
 * Only enumerated / numeric fields — no free text. `reason` is deliberately
 * NOT forwarded: policy reasons are operator-authored strings that can quote
 * user content, and the envelope is signed and durable.
 */
export function toDecisionStub(input: TraceTurnDecisionInput): DecisionPacketStub {
  const blocked = !!input.block;
  const decision = decisionFor(input.block);
  const side_effect_level = sideEffectLevelFor(input.packet, blocked);
  const policy_id = input.block?.policy_id ?? input.packet.policy_decisions[0]?.policy_id ?? null;

  return {
    decision,
    side_effect_level,
    policy_id,
    risk_score: riskScoreFor(input.packet.risk_profile.level),
    policy_hooks: input.packet.policy_decisions.map((d) => ({
      hook: d.pep,
      policy_id: d.policy_id,
      // The PEP verdict, an enum — not the operator's free-text reason.
      effect: d.decision,
    })),
  };
}

/**
 * Build the body packet.
 *
 * Every key here is on the redaction allowlist
 * (`runtime-trace/lib/redaction.ts`), so `_redaction_dropped_unknown_count`
 * stays 0 and nothing is silently discarded. Crucially there is NO message
 * text, no media ref, no phone, no push name: the hot-path packet carries a
 * `content_hmac`/`content_ref` and that is all the evidence trail needs.
 */
export function toContextStub(input: TraceTurnDecisionInput): ExecutionContextPacketStub {
  const { base, packet } = input;
  const hooks = packet.policy_decisions;
  return {
    trace_id: base.trace_id,
    tenant_id: base.tenant_id,
    agent_id: base.agent_id,
    conversa_id: asUuidOrNull(base.conversation_id),
    turno_id: asUuidOrNull(base.input.content_ref),
    request: {
      direction: 'inbound',
      // No `text`, no `media_refs`. Redaction would strip them anyway; not
      // collecting them in the first place is the stronger guarantee.
    },
    decision_meta: {
      risk_score: riskScoreFor(packet.risk_profile.level),
      hook_count: hooks.length,
      hook_pass_count: hooks.filter((h) => h.decision === 'allow').length,
      hook_fail_count: hooks.filter((h) => h.decision !== 'allow').length,
      evaluation_ms: input.evaluation_ms ?? 0,
      trace_id: base.trace_id,
    },
  };
}

/**
 * Write the durable trace for a turn's decision.
 *
 * @returns the written envelope, or `null` when tracing is disabled/skipped.
 * @throws when the envelope was REQUIRED and could not be written — the caller
 *         must then abort the side effect (P10b invariant 12).
 */
export async function traceTurnDecision(
  input: TraceTurnDecisionInput,
): Promise<TraceEnvelopeWritten | null> {
  // Attribute from the PACKET, not from ALS: the turn's tenant is an explicit
  // property of the decision we are recording, and coverage must be
  // per-tenant-auditable even if a caller forgot to open the tenant scope.
  const attribution = {
    tenant_id: input.base.tenant_id,
    agent_id: input.base.agent_id,
  };

  if (!runtimeTraceHotPathEnabled()) {
    counter(METRIC.TRACE_COVERAGE, { ...attribution, result: 'skipped', reason: 'disabled' });
    return null;
  }

  const trace_id = asUuidOrNull(input.base.trace_id);
  if (!trace_id) {
    // Non-UUID trace id (a standalone caller that never opened a correlation
    // scope). Skip rather than crash the turn on a UUID column.
    counter(METRIC.TRACE_COVERAGE, {
      ...attribution,
      result: 'skipped',
      reason: 'trace_id_shape',
    });
    return null;
  }

  const decision = toDecisionStub(input);
  const required = envelopeIsRequired(decision.side_effect_level);

  try {
    const t0 = performance.now();
    const env = await trace({
      trace_id,
      tenant_id: input.base.tenant_id,
      agent_id: input.base.agent_id,
      conversa_id: asUuidOrNull(input.base.conversation_id),
      turno_id: asUuidOrNull(input.base.input.content_ref),
      packet: toContextStub(input),
      decision,
      redaction_class: 'standard',
    });
    histogram(METRIC.STAGE_DURATION_MS, performance.now() - t0, {
      ...attribution,
      stage: 'runtime_trace_envelope',
    });
    counter(METRIC.TRACE_COVERAGE, {
      ...attribution,
      result: 'written',
      required: required ? 'true' : 'false',
      decision: decision.decision,
      side_effect_level: decision.side_effect_level,
    });
    return env;
  } catch (err) {
    counter(METRIC.TRACE_COVERAGE, {
      ...attribution,
      result: 'failed',
      required: required ? 'true' : 'false',
      side_effect_level: decision.side_effect_level,
    });
    logger.error(
      { err, tenant_id: input.base.tenant_id, required, ...correlationLogFields() },
      'runtime_trace.hot_path_envelope_failed',
    );
    if (required) {
      // FAIL-LOUD: the caller must not proceed with the side effect.
      throw err;
    }
    return null;
  }
}

/** Diagnostic helper for logs — the attempt the envelope belongs to. */
export function currentAttempt(): number | null {
  return tryGetCorrelation()?.attempt ?? null;
}
