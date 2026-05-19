/**
 * P10b — Runtime Trace public API.
 *
 * Consumer surface:
 *
 *   import { trace } from '@/control-plane/runtime-trace/index.js';
 *
 *   await trace({
 *     trace_id, tenant_id, agent_id,
 *     packet,        // ExecutionContextPacket
 *     decision,      // DecisionPacket
 *     conversa_id, turno_id,
 *     redaction_class: 'standard', // | 'debug' | 'minimal'
 *   });
 *   // ↑ envelope + body-outbox row written sync (<20ms) in one
 *   //   transaction; body persisted async by trace-body-writer worker.
 *
 * Direct callers:
 *   - PEP wrappers (Late hook, after policy evaluation).
 *   - Side-effectful tools (transactions, message send) — wrap the call.
 *
 * Feature gate: callers should check featureFlags.isEnabled(RUNTIME_TRACE_V1).
 * When OFF, `trace()` is a no-op that returns a synthetic envelope-written
 * shape so the caller path doesn't branch on the flag everywhere.
 *
 * Durability (Codex review #102 — issue 4):
 *   envelope + body outbox row are written in one DB transaction so a
 *   process crash between envelope-write and enqueueBody() can no longer
 *   strand the packet in volatile memory. The in-process Map is a perf
 *   accelerator only; the worker drains the durable outbox as the source
 *   of truth.
 */
export { writeEnvelope } from './envelope-writer.js';
export { writeBody } from './body-writer.js';
export { redactPacket } from './lib/redaction.js';
export {
  signHmac,
  verifyHmac,
  canonicalJson,
  currentKeyVersion,
  deriveTenantKey,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
  _clearTestMasterSecretForTests,
} from './lib/hmac.js';
export { encryptForDebug, uploadDebugSnapshot } from './lib/debug-encrypt.js';
export type {
  Decision,
  SideEffectLevel,
  RedactionClass,
  BodyStatus,
  RedactionApplied,
  ExecutionContextPacketStub,
  DecisionPacketStub,
  TraceEnvelopeInput,
  TraceEnvelopeWritten,
  TraceBodyInput,
  TraceBodyWritten,
} from './types.js';
export {
  envelopeIsRequired,
  SIDE_EFFECT_LEVELS_REQUIRING_ENVELOPE,
  SIDE_EFFECT_LEVEL_RANK,
} from './types.js';

import type {
  TraceEnvelopeInput,
  TraceEnvelopeWritten,
  TraceBodyInput,
  ExecutionContextPacketStub,
  DecisionPacketStub,
  RedactionClass,
} from './types.js';
import { writeEnvelope } from './envelope-writer.js';
import { enqueueBody } from '@/workers/trace-body-writer.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

export interface TraceInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id?: string | null;
  turno_id?: string | null;
  packet: ExecutionContextPacketStub;
  decision: DecisionPacketStub;
  redaction_class?: RedactionClass;
}

/**
 * One-shot trace: write envelope + body outbox row sync (one transaction),
 * also enqueue in-memory as an accelerator. Returns the envelope record.
 * If the flag is OFF, returns a no-op envelope (does NOT touch the DB).
 *
 * Throws if envelope write fails — caller MUST abort the side effect.
 */
export async function trace(input: TraceInput): Promise<TraceEnvelopeWritten> {
  if (!featureFlags.isEnabled(FeatureFlagName.RUNTIME_TRACE_V1)) {
    return {
      trace_id: input.trace_id,
      envelope_hmac: '',
      hmac_key_version: 0,
      side_effect_level: input.decision.side_effect_level,
      decision: input.decision.decision,
      policy_id: input.decision.policy_id ?? null,
      redaction_class: input.redaction_class ?? 'standard',
      sync_latency_ms: 0,
    };
  }

  const envelopeInput: TraceEnvelopeInput = {
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    conversa_id: input.conversa_id,
    turno_id: input.turno_id,
    decision: input.decision,
    redaction_class: input.redaction_class,
  };

  const bodyInput: TraceBodyInput = {
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    packet: input.packet,
    decision: input.decision,
    redaction_class: input.redaction_class ?? 'standard',
  };

  // envelope + outbox row in one transaction. Worker drains outbox.
  const env = await writeEnvelope(envelopeInput, { outbox_body: bodyInput });

  // Also enqueue in-memory: the worker drains both, and the outbox row
  // is the source of truth. This is a no-op for durability but lets the
  // worker pick up bodies a tick faster than the DB poll path.
  enqueueBody(bodyInput);

  return env;
}
