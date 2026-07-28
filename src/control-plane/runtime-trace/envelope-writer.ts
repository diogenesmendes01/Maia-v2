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

/**
 * The exact field set covered by `envelope_hmac`, in one place.
 *
 * Issue #514 review round 1 [P2]: the Trace Explorer needs to VERIFY this
 * signature, not just check that the string is non-empty. Signer and verifier
 * must agree byte-for-byte, so both go through this function — a field added
 * to the signature here is automatically covered by the check, and the two
 * cannot silently drift apart.
 *
 * `canonicalJson` (in `lib/hmac.ts`) sorts keys, so declaration order here is
 * irrelevant; what matters is the SET of fields and their exact values.
 */
export interface EnvelopeSignedFields {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id: string | null;
  turno_id: string | null;
  policy_id: string | null;
  decision: Decision;
  side_effect_level: SideEffectLevel;
  redaction_class: string;
  hmac_key_version: number;
}

export function envelopeSignedPayload(fields: EnvelopeSignedFields): EnvelopeSignedFields {
  return {
    trace_id: fields.trace_id,
    tenant_id: fields.tenant_id,
    agent_id: fields.agent_id,
    conversa_id: fields.conversa_id ?? null,
    turno_id: fields.turno_id ?? null,
    policy_id: fields.policy_id ?? null,
    decision: fields.decision,
    side_effect_level: fields.side_effect_level,
    redaction_class: fields.redaction_class,
    hmac_key_version: fields.hmac_key_version,
  };
}

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
  const signedPayload = envelopeSignedPayload({
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
  });
  const envelope_hmac = signHmac(input.tenant_id, hmac_key_version, signedPayload);

  try {
    if (options.outbox_body) {
      // Durable path: envelope + outbox row in one transaction.
      // If the body INSERT fails, the envelope is rolled back too — we'd
      // rather lose the envelope (no proof) than the body (lost evidence
      // attached to a phantom envelope).
      await db.transaction(async (tx) => {
        await tx
          .insert(runtime_trace_envelopes)
          .values({
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
          })
          // Issue #514 review round 1 [P1]: the writer is at-least-once by
          // construction (BullMQ retries, the recovery sweep, the outbox
          // relayer). Re-writing the SAME envelope must be a no-op, not a
          // unique violation that fails the turn closed. Distinct ATTEMPTS get
          // distinct ids upstream (`envelopeTraceIdForAttempt`), so a conflict
          // here means "this exact attempt was already recorded" — the
          // evidence requirement is satisfied either way. Mirrors the outbox
          // insert just below, which has always been conflict-tolerant.
          .onConflictDoNothing();
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
      await db
        .insert(runtime_trace_envelopes)
        .values({
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
        })
        // Same at-least-once rationale as the transactional path above.
        .onConflictDoNothing();
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
