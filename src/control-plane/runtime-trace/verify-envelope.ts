/**
 * Issue #514 §7 / review round 1 [P2] — real integrity verification for the
 * Trace Explorer.
 *
 * The previous revision reported `envelope_signed: envelope_hmac.length > 0`.
 * That is worse than showing nothing: a tampered envelope was presented to the
 * operator as "signed", and an operator makes decisions on that during an
 * incident. Either verify the signature or say you could not.
 *
 * Three outcomes, deliberately distinct:
 *
 *   - `verified` — the HMAC recomputes over the row's own fields. The row has
 *     not been altered since it was written.
 *   - `invalid`  — it does NOT recompute. Either a field was changed or the
 *     signature was. Treat as an integrity incident.
 *   - `unknown`  — verification could not run: the master secret for that key
 *     version is not configured in THIS process (a rotated-out key, a reader
 *     deployed without the secret). Absence of proof is not proof of absence,
 *     so this must never be collapsed into `invalid`.
 */
import { envelopeSignedPayload, type EnvelopeSignedFields } from './envelope-writer.js';
import { verifyHmac } from './lib/hmac.js';
import { logger } from '@/lib/logger.js';

export type EnvelopeIntegrity = 'verified' | 'invalid' | 'unknown';

/** Row shape needed to verify — a subset of `runtime_trace_envelopes`. */
export interface VerifiableEnvelopeRow extends EnvelopeSignedFields {
  envelope_hmac: string;
}

/**
 * Recompute the envelope HMAC and compare.
 *
 * Never throws: an integrity check that can crash the detail page is an
 * availability bug in the incident tool you reach for during an incident.
 */
export function verifyEnvelopeIntegrity(row: VerifiableEnvelopeRow): EnvelopeIntegrity {
  if (typeof row.envelope_hmac !== 'string' || row.envelope_hmac.length === 0) {
    // No signature at all. Not "unknown" — a signature was required at write
    // time, so its absence is a real integrity failure.
    return 'invalid';
  }
  try {
    const ok = verifyHmac(
      row.tenant_id,
      row.hmac_key_version,
      envelopeSignedPayload(row),
      row.envelope_hmac,
    );
    return ok ? 'verified' : 'invalid';
  } catch (err) {
    // `lib/hmac.ts` fails closed when the master secret for the version is not
    // available. That is a CONFIGURATION gap, not evidence of tampering.
    logger.warn(
      { err, trace_id: row.trace_id, hmac_key_version: row.hmac_key_version },
      'runtime_trace.envelope_verify_unavailable',
    );
    return 'unknown';
  }
}
