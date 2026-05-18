/**
 * P10b — Async body writer.
 *
 * Called by the TraceBody worker (or directly from the request path as
 * a fire-and-forget) to persist the redacted body. Uses ON CONFLICT
 * (trace_id) DO NOTHING so re-deliveries are idempotent.
 *
 * Three paths:
 *   - standard / minimal → redactPacket() then INSERT body.
 *   - debug              → encryptForDebug() + uploadDebugSnapshot() then
 *                          INSERT body with encrypted=true and EITHER
 *                          s3_uri (bucket configured) OR ciphertext_inline
 *                          (no bucket — test/dev). The DB CHECK constraint
 *                          requires at least one to be present (issue 3).
 *
 * After successful body INSERT, flips the envelope's body_status to
 * 'persisted' and stamps body_persisted_at. The flip is best-effort —
 * if it fails, the recoverer cron will retry.
 */
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import type { TraceBodyInput, TraceBodyWritten } from './types.js';
import { redactPacket } from './lib/redaction.js';
import { signHmac, currentKeyVersion } from './lib/hmac.js';
import { encryptForDebug, uploadDebugSnapshot } from './lib/debug-encrypt.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';

/**
 * Persist the body. Safe to call multiple times for the same trace_id.
 * Returns the written record. Does NOT throw on the envelope flip step
 * (recoverer handles).
 */
export async function writeBody(input: TraceBodyInput): Promise<TraceBodyWritten> {
  const t0 = performance.now();
  const redacted = redactPacket(input.packet, input.redaction_class);
  const hmac_key_version = currentKeyVersion();

  let packetForRow: Record<string, unknown>;
  let encrypted = false;
  let s3_uri: string | null = null;
  let ciphertext_inline: string | null = null;

  if (input.redaction_class === 'debug') {
    const cipher = encryptForDebug(input.packet);
    if (!cipher) {
      // Debug requested but AES key absent — fall back to standard and
      // alert; never silent-drop the body.
      logger.warn(
        { trace_id: input.trace_id },
        'runtime_trace.debug_aes_key_missing_fallback_standard',
      );
      const fallback = redactPacket(input.packet, 'standard');
      packetForRow = fallback.packet ?? {};
      redacted.bytes_redacted = fallback.bytes_redacted;
      redacted.redaction_applied = 'standard_v1';
    } else {
      // Codex review #102 — issue 3: upload BEFORE marking persisted.
      // uploadDebugSnapshot now either does a real S3 PutObject (bucket
      // configured) or returns inline ciphertext for DB storage. Throws
      // on S3 upload failure so we never mark a body persisted while the
      // ciphertext is unrecoverable.
      const upload = await uploadDebugSnapshot(input.trace_id, cipher);
      s3_uri = upload.s3_uri;
      ciphertext_inline = upload.inline;
      encrypted = true;
      // The DB body row stores only the cipher envelope metadata + pointer.
      packetForRow = {
        __encrypted: true,
        cipher: { iv: cipher.iv, tag: cipher.tag, key_version: cipher.key_version },
        storage: upload.storage,
        s3_uri,
      };
    }
  } else if (input.redaction_class === 'minimal') {
    packetForRow = { __minimal: true };
  } else {
    packetForRow = redacted.packet ?? {};
  }

  const packet_hmac = signHmac(input.tenant_id, hmac_key_version, packetForRow);

  // INSERT ... ON CONFLICT DO NOTHING (idempotent under at-least-once
  // delivery from the durable outbox / in-process queue / recoverer).
  await db.execute(
    sql`INSERT INTO runtime_trace_bodies (
      trace_id, tenant_id, agent_id, packet, packet_hmac,
      hmac_key_version, redaction_applied, bytes_redacted, encrypted, s3_uri, ciphertext_inline
    ) VALUES (
      ${input.trace_id}, ${input.tenant_id}, ${input.agent_id},
      ${JSON.stringify(packetForRow)}::jsonb, ${packet_hmac},
      ${hmac_key_version}, ${redacted.redaction_applied},
      ${redacted.bytes_redacted}, ${encrypted}, ${s3_uri}, ${ciphertext_inline}
    ) ON CONFLICT (trace_id) DO NOTHING`,
  );

  // Best-effort envelope flip. Race-tolerant: envelope may already be 'persisted'
  // if a previous body-writer attempt succeeded; the UPDATE still works.
  try {
    await db.execute(
      sql`UPDATE runtime_trace_envelopes
          SET body_status = 'persisted', body_persisted_at = now()
          WHERE trace_id = ${input.trace_id}`,
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, trace_id: input.trace_id },
      'runtime_trace.envelope_flip_failed',
    );
  }

  const latency = performance.now() - t0;
  incCounter('maia_runtime_trace_body_written_total', {
    redaction: redacted.redaction_applied,
    encrypted: String(encrypted),
  });
  observeHistogram('maia_runtime_trace_body_latency_ms', latency);

  return {
    trace_id: input.trace_id,
    packet_hmac,
    hmac_key_version,
    redaction_applied: redacted.redaction_applied,
    bytes_redacted: redacted.bytes_redacted,
    encrypted,
    s3_uri,
  };
}
