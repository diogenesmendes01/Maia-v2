/**
 * P10b — Runtime Trace types.
 *
 * Two-table pattern:
 *   1. runtime_trace_envelopes — sync (<20ms), written BEFORE side effects
 *      with side_effect_level >= medium (CRITICAL invariant 12).
 *   2. runtime_trace_bodies — async, written by the TraceBody worker
 *      via FOR UPDATE SKIP LOCKED + ON CONFLICT DO NOTHING.
 *
 * Integrates with P8a ExecutionContextPacket and P9b DecisionPacket.
 * Both are stubbed locally to avoid blocking on not-yet-merged work.
 */

export type Decision = 'allow' | 'deny' | 'soft_block' | 'escalate' | 'observe';

export type SideEffectLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type RedactionClass = 'standard' | 'debug' | 'minimal';

export type BodyStatus = 'pending' | 'persisted' | 'orphaned';

export type RedactionApplied =
  | 'standard_v1'
  | 'debug_encrypted_v1'
  | 'minimal_v1';

/**
 * P8a ExecutionContextPacket — stubbed shape. Real type lives in
 * `@/control-plane/context-packet/types.js` once #96 merges.
 * Only the fields the trace touches are listed.
 */
export interface ExecutionContextPacketStub {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id?: string | null;
  turno_id?: string | null;
  request?: {
    direction?: 'inbound' | 'outbound';
    text?: string;
    media_refs?: string[];
  };
  // Slices (P8b/P8c context). Opaque from trace POV.
  soul?: Record<string, unknown>;
  user_layer?: Record<string, unknown>;
  // Anything else the packet builders add.
  [k: string]: unknown;
}

/**
 * P9b DecisionPacket — stubbed shape. Real type lives in
 * `@/control-plane/decision-engine/types.js` once that PR merges.
 */
export interface DecisionPacketStub {
  decision: Decision;
  side_effect_level: SideEffectLevel;
  policy_id?: string | null;
  // Hooks that ran (Early/Mid/Late PEPs).
  policy_hooks?: Array<{
    hook: 'early' | 'mid' | 'late';
    policy_id: string;
    effect?: string | null;
  }>;
  reason?: string;
  risk_score?: number;
}

/**
 * Input to the synchronous envelope writer. Called BEFORE any side effect
 * with side_effect_level >= medium executes (Invariant 12).
 */
export interface TraceEnvelopeInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id?: string | null;
  turno_id?: string | null;
  decision: DecisionPacketStub;
  redaction_class?: RedactionClass; // default 'standard'
}

export interface TraceEnvelopeWritten {
  trace_id: string;
  envelope_hmac: string;
  hmac_key_version: number;
  side_effect_level: SideEffectLevel;
  decision: Decision;
  policy_id: string | null;
  redaction_class: RedactionClass;
  sync_latency_ms: number;
}

/**
 * Input to the async body writer (enqueued after envelope).
 */
export interface TraceBodyInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  packet: ExecutionContextPacketStub;
  decision: DecisionPacketStub;
  redaction_class: RedactionClass;
}

export interface TraceBodyWritten {
  trace_id: string;
  packet_hmac: string;
  hmac_key_version: number;
  redaction_applied: RedactionApplied;
  bytes_redacted: number;
  encrypted: boolean;
  s3_uri: string | null;
}

/** Decision values for which the envelope MUST precede the side effect. */
export const SIDE_EFFECT_LEVELS_REQUIRING_ENVELOPE: ReadonlySet<SideEffectLevel> =
  new Set<SideEffectLevel>(['medium', 'high', 'critical']);

/** Cardinal numeric ranking for comparison (`>=`). */
export const SIDE_EFFECT_LEVEL_RANK: Record<SideEffectLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function envelopeIsRequired(level: SideEffectLevel): boolean {
  return SIDE_EFFECT_LEVELS_REQUIRING_ENVELOPE.has(level);
}
