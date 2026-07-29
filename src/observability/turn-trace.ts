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
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { counter, histogram } from './metrics.js';
import { METRIC } from './taxonomy.js';
import { correlationLogFields, deriveTraceId, tryGetCorrelation } from './correlation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A MANDATORY envelope could not be written, so the turn must not proceed.
 *
 * Review round 1 [P1]: the previous revision rethrew the raw DB error. Its
 * caller (`src/agent/core.ts`) only recognises typed block errors — everything
 * else is logged as `wiring_error_continuing` and the turn falls through to
 * `runReActLoop`, which could then run a tool or send an outbound with NO
 * envelope. That silently inverted the fail-closed guarantee the PR claimed.
 *
 * A distinct type (rather than reusing `DecisionEngineFailClosedError`) keeps
 * the incident legible: the engine did NOT crash, the evidence write did.
 * `cause_error` carries the original for the log.
 */
export class MandatoryTraceEnvelopeError extends Error {
  readonly code = 'MANDATORY_TRACE_ENVELOPE_FAILED';
  constructor(
    readonly cause_error: unknown,
    readonly tenant_id: string,
    readonly side_effect_level: SideEffectLevel,
  ) {
    super(
      `Runtime trace: mandatory envelope write failed for tenant=${tenant_id} ` +
        `side_effect_level=${side_effect_level}; turn MUST be blocked (P10b invariant 12)`,
    );
    this.name = 'MandatoryTraceEnvelopeError';
  }
}

/**
 * `runtime_trace_envelopes.{trace_id,conversa_id,turno_id}` are UUID columns.
 * Anything else must not reach the INSERT — a malformed id would turn an
 * observability write into a turn-breaking DB error.
 */
function asUuidOrNull(v: string | null | undefined): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * Rollout gate, read through the typed config loader (issue #515 — no direct
 * `process.env` reads outside the contract).
 *
 * NOTE the behaviour change this implies: the value is now resolved at BOOT,
 * not per call, so flipping the flag requires a process restart. That is why
 * the contract marks it `restartRequired: true`, matching every other
 * `FEATURE_*` flag. The canary procedure in
 * `docs/runbooks/observability-slo.md` §7 is written accordingly.
 */
export function runtimeTraceHotPathEnabled(): boolean {
  return config.FEATURE_RUNTIME_TRACE_V1;
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
    // Review round 1 [P2]: the PERSISTED body carried no `policy_hooks`, but
    // the Trace Explorer reads `redacted_packet.policy_hooks` exclusively — so
    // the detail page showed "nenhuma decisão PEP" even for turns where policy
    // actually fired. `toDecisionStub` had the hooks; only the envelope saw
    // them, and the envelope is not what the Explorer renders.
    //
    // Projected into the shape `lib/redaction.ts` ALLOWS for hooks
    // (`hook_id`, `hook_name`, `outcome`, `error_code`, `duration_ms`,
    // `version`) — anything else would be dropped on write, which is how this
    // silently produced an empty array. Note what is deliberately absent:
    // `rule_descriptor` and `reason` are operator/LLM-authored free text that
    // can quote user content, so they never reach durable storage. The
    // enumerated verdict is the whole evidentiary payload.
    policy_hooks: hooks.map((d) => ({
      hook_name: d.pep,
      hook_id: d.policy_id,
      outcome: d.decision,
    })),
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

  const root_trace_id = asUuidOrNull(input.base.trace_id);
  // Attempt-scoped PK so a retry of the same turn does not collide with the
  // envelope attempt 1 already wrote (review round 1 [P1]).
  const attempt = tryGetCorrelation()?.attempt ?? 1;
  const trace_id = root_trace_id
    ? envelopeTraceIdForAttempt(root_trace_id, attempt)
    : null;
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
      // Review round 2 [P1]: persist the root/attempt relation that until now
      // existed only in the correlation ALS, so the Explorer can group the
      // attempts of one turn instead of listing N unrelated traces.
      root_trace_id,
      attempt,
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
      // FAIL-LOUD, as a TYPED error the caller recognises as a block. Throwing
      // the raw DB error here is what let the turn continue to ReAct in the
      // previous revision (review round 1 [P1]).
      throw new MandatoryTraceEnvelopeError(
        err,
        input.base.tenant_id,
        decision.side_effect_level,
      );
    }
    return null;
  }
}

/** Diagnostic helper for logs — the attempt the envelope belongs to. */
export function currentAttempt(): number | null {
  return tryGetCorrelation()?.attempt ?? null;
}

/**
 * Envelope primary key for a given attempt of a turn.
 *
 * Review round 1 [P1]: `runtime_trace_envelopes.trace_id` is the PRIMARY KEY
 * and the writer does a plain INSERT. Retry and recovery deliberately reuse the
 * SAME root trace id (that is the whole correlation contract), so the second
 * attempt hit a unique violation — and, because the envelope is mandatory for
 * effect-capable turns, that violation *became* a turn-blocking error. A retry
 * could never succeed.
 *
 * Resolution — attempts are modelled separately without colliding with the
 * root:
 *   - attempt 1 uses the ROOT trace id, so the id an operator sees is still the
 *     turn's id and nothing about the existing Explorer link changes;
 *   - attempt N>1 uses a DETERMINISTIC id derived from `${root}:attempt:N`.
 *     Deterministic (not random) so a re-run of the same attempt is idempotent
 *     rather than a new row every time.
 *
 * Correlation survives because every attempt carries the same `turno_id` (the
 * persisted inbound row id) and the same `conversa_id` on the envelope — those
 * are the columns that group attempts of one turn, and both are already
 * indexed and surfaced by the Explorer.
 */
export function envelopeTraceIdForAttempt(rootTraceId: string, attempt: number): string {
  if (attempt <= 1) return rootTraceId;
  return deriveTraceId(`${rootTraceId}:attempt:${attempt}`);
}
