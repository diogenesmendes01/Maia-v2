/**
 * P10b — Async body writer.
 *
 * Called by the TraceBody worker (or directly from the request path as
 * a fire-and-forget) to persist the redacted body. Idempotent: checks
 * for an existing body row BEFORE any external write (S3/DB). This
 * prevents duplicate S3 uploads that could overwrite the ciphertext that
 * won the original INSERT (round-2 finding #2 fix).
 *
 * Three paths:
 *   - standard / minimal → redactPacket() then INSERT body.
 *   - debug              → check existing → encryptForDebug() +
 *                          uploadDebugSnapshot() → INSERT body with
 *                          encrypted=true and EITHER s3_uri (bucket
 *                          configured) OR ciphertext_inline (no bucket —
 *                          test/dev). The DB CHECK constraint requires at
 *                          least one to be present.
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
 * Idempotency check: returns the existing body row metadata if a body has
 * already been persisted for this trace_id. Callers MUST call this before
 * any external write (S3 upload, DB insert) to avoid generating new
 * IV/ciphertext that would overwrite the bytes the first INSERT won.
 *
 * Round-2 finding #2 — body writes were not idempotent: retries after a
 * partial success (S3 upload succeeded, outbox-delete failed) generated a
 * new cipher and re-uploaded, while the DB row remained pointing at the
 * FIRST cipher (ON CONFLICT DO NOTHING). The S3 object was then a
 * ciphertext mismatch, making the audit row unrecoverable.
 */
async function findExistingBody(trace_id: string): Promise<{
  packet_hmac: string;
  hmac_key_version: number;
  redaction_applied: string;
  bytes_redacted: number;
  encrypted: boolean;
  s3_uri: string | null;
} | null> {
  const rows = await db.execute(
    sql`SELECT packet_hmac, hmac_key_version, redaction_applied,
               bytes_redacted, encrypted, s3_uri
        FROM runtime_trace_bodies
        WHERE trace_id = ${trace_id}
        LIMIT 1`,
  );
  const rowsAny = rows as { rows?: unknown[] } | null | undefined;
  const row = rowsAny?.rows?.[0] as
    | {
        packet_hmac: string;
        hmac_key_version: number;
        redaction_applied: string;
        bytes_redacted: number;
        encrypted: boolean;
        s3_uri: string | null;
      }
    | undefined;
  return row ?? null;
}

/**
 * Persist the body. Safe to call multiple times for the same trace_id.
 * Returns the written record. Does NOT throw on the envelope flip step
 * (recoverer handles).
 *
 * Idempotency contract (round-2 finding #2):
 *   1. Check DB for existing body FIRST.
 *   2. If already present, return existing row metadata — NO new S3 upload.
 *   3. Only if absent: encrypt + upload to S3 + INSERT.
 *   4. Envelope flip happens only after both DB row + S3 object are known good.
 */
export async function writeBody(input: TraceBodyInput): Promise<TraceBodyWritten> {
  const t0 = performance.now();

  // --- Idempotency guard: skip all external writes if body already exists ---
  const existing = await findExistingBody(input.trace_id);
  if (existing) {
    logger.debug(
      { trace_id: input.trace_id },
      'runtime_trace.body_already_exists_skip_write',
    );
    // Still attempt the envelope flip — it may have failed on the prior pass.
    try {
      await db.execute(
        sql`UPDATE runtime_trace_envelopes
            SET body_status = 'persisted', body_persisted_at = now()
            WHERE trace_id = ${input.trace_id} AND body_status != 'persisted'`,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, trace_id: input.trace_id },
        'runtime_trace.envelope_flip_failed',
      );
    }
    incCounter('maia_runtime_trace_body_written_total', {
      redaction: existing.redaction_applied,
      encrypted: String(existing.encrypted),
      idempotent_skip: 'true',
    });
    return {
      trace_id: input.trace_id,
      packet_hmac: existing.packet_hmac,
      hmac_key_version: existing.hmac_key_version,
      redaction_applied: existing.redaction_applied as import('./types.js').TraceBodyWritten['redaction_applied'],
      bytes_redacted: existing.bytes_redacted,
      encrypted: existing.encrypted,
      s3_uri: existing.s3_uri,
    };
  }

  // --- No existing body: proceed with full write path ---
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
      // Round-2 fix: upload ONLY after idempotency check above confirms no
      // body exists. This prevents a new IV/ciphertext overwriting the bytes
      // the first INSERT won (deterministic S3 key = same object per trace_id).
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

  // INSERT ... ON CONFLICT DO NOTHING (race-safe second barrier after the
  // in-process check above: two workers racing can still both reach here).
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
