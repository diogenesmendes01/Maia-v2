/**
 * P10b — Synchronous envelope writer (CRITICAL invariant 12).
 *
 * MUST be called BEFORE any side effect with side_effect_level >= medium.
 * The envelope is the audit record proving the decision was made and
 * recorded; if the side effect crashes after this, we still have proof.
 *
 * Hot path discipline:
 *   - Single INSERT (or paired INSERT envelope + outbox in one transaction).
 *   - HMAC over canonical-JSON of the envelope minus envelope_hmac.
 *   - p99 < 20ms (audit gate).
 *
 * On failure: throws. Callers MUST NOT proceed with the side effect when
 * envelope write fails — that would violate invariant 12.
 *
 * Codex review #102 — issue 4 (durability):
 *   When `outbox_body` is provided, we write envelope + body outbox row
 *   in the same DB transaction. This means a process crash between the
 *   envelope write and the in-process enqueueBody() call no longer loses
 *   the packet — the worker picks it up from the durable outbox table.
 */
import { db } from '@/db/client.js';
import {
  runtime_trace_envelopes,
  runtime_trace_body_outbox,
} from '@/db/schema.js';
import type {
  TraceEnvelopeInput,
  TraceEnvelopeWritten,
  SideEffectLevel,
  Decision,
  TraceBodyInput,
} from './types.js';
import { signHmac, currentKeyVersion } from './lib/hmac.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';

export interface EnvelopeWriteOptions {
  /**
   * If supplied, write a durable outbox row in the same transaction as
   * the envelope. The body-writer worker will drain the outbox via
   * FOR UPDATE SKIP LOCKED. Without this option, the caller is
   * responsible for in-process enqueueBody (less durable; recoverable
   * via the recoverer cron at the cost of evidence detail).
   */
  outbox_body?: TraceBodyInput;
}

/**
 * Write the envelope synchronously. Returns the written record + sync
 * latency. Throws on DB failure — caller MUST abort the side effect.
 */
export async function writeEnvelope(
  input: TraceEnvelopeInput,
  options: EnvelopeWriteOptions = {},
): Promise<TraceEnvelopeWritten> {
  const t0 = performance.now();
  const redaction_class = input.redaction_class ?? 'standard';
  const side_effect_level: SideEffectLevel = input.decision.side_effect_level;
  const decision: Decision = input.decision.decision;
  const policy_id = input.decision.policy_id ?? null;
  const hmac_key_version = currentKeyVersion();

  // Payload to sign — canonical JSON guarantees stable bytes regardless of
  // insertion order. We sign the envelope contents (no DB-assigned fields).
  const signedPayload = {
    trace_id: input.trace_id,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    conversa_id: input.conversa_id ?? null,
    turno_id: input.turno_id ?? null,
    policy_id,
    decision,
    side_effect_level,
    redaction_class,
    hmac_key_version,
  };
  const envelope_hmac = signHmac(input.tenant_id, hmac_key_version, signedPayload);

  try {
    if (options.outbox_body) {
      // Durable path: envelope + outbox row in one transaction.
      // If the body INSERT fails, the envelope is rolled back too — we'd
      // rather lose the envelope (no proof) than the body (lost evidence
      // attached to a phantom envelope).
      await db.transaction(async (tx) => {
        await tx.insert(runtime_trace_envelopes).values({
          trace_id: input.trace_id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          conversa_id: input.conversa_id ?? null,
          turno_id: input.turno_id ?? null,
          policy_id,
          decision,
          side_effect_level,
          redaction_class,
          envelope_hmac,
          hmac_key_version,
          body_status: 'pending',
        });
        const bodyForOutbox = options.outbox_body!;
        await tx
          .insert(runtime_trace_body_outbox)
          .values({
            trace_id: input.trace_id,
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            payload: bodyForOutbox as unknown as Record<string, unknown>,
            redaction_class,
          })
          .onConflictDoNothing();
      });
    } else {
      // Best-effort path (legacy callers / minimal redaction).
      await db.insert(runtime_trace_envelopes).values({
        trace_id: input.trace_id,
        tenant_id: input.tenant_id,
        agent_id: input.agent_id,
        conversa_id: input.conversa_id ?? null,
        turno_id: input.turno_id ?? null,
        policy_id,
        decision,
        side_effect_level,
        redaction_class,
        envelope_hmac,
        hmac_key_version,
        body_status: 'pending',
      });
    }
  } catch (err) {
    incCounter('maia_runtime_trace_envelope_write_failed_total', {
      decision,
      side_effect_level,
    });
    logger.error(
      { err, trace_id: input.trace_id, decision, side_effect_level },
      'runtime_trace.envelope_write_failed',
    );
    throw err;
  }

  const sync_latency_ms = performance.now() - t0;
  incCounter('maia_runtime_trace_envelope_written_total', {
    decision,
    side_effect_level,
    redaction_class,
  });
  observeHistogram('maia_runtime_trace_envelope_latency_ms', sync_latency_ms);

  return {
    trace_id: input.trace_id,
    envelope_hmac,
    hmac_key_version,
    side_effect_level,
    decision,
    policy_id,
    redaction_class,
    sync_latency_ms,
  };
}
