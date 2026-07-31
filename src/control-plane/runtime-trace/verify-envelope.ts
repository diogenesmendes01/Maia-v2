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
 *
 * Issue #535 adds a SECOND version axis, orthogonal to the key version: which
 * field set the signature covers (`envelope_payload_version`, migration 119).
 * v1 rows are checked against the v1 payload, v2 rows against the v2 payload
 * that also covers `root_trace_id`/`attempt`. `unknown` stays reserved for the
 * key axis — see `verifyEnvelopeIntegrity` for why an unrecognised PAYLOAD
 * version is `invalid` rather than `unknown`.
 */
import {
  envelopeSignedPayload,
  isKnownEnvelopePayloadVersion,
  type EnvelopeSignedFields,
} from './envelope-writer.js';
import { verifyHmac } from './lib/hmac.js';
import { logger } from '@/lib/logger.js';

export type EnvelopeIntegrity = 'verified' | 'invalid' | 'unknown';

/**
 * The body row's own signature (issue #514 review round 2 [P2]).
 *
 * `body-writer.ts` signs the EXACT jsonb it stores in `packet`
 * (`signHmac(tenant_id, hmac_key_version, packetForRow)`), so verification is
 * the same recomputation as the envelope's — and it was the same omission:
 * `packet_hmac` was persisted and never read back. An operator reading a trace
 * body during an incident deserves to know whether the body still matches its
 * signature.
 *
 * Adds a fourth state the envelope does not need: `absent`, for a body that has
 * not been persisted yet (`body_status: 'pending'`). Nothing to verify is not
 * the same as failing to verify, and neither is the same as invalid.
 */
export type BodyIntegrity = EnvelopeIntegrity | 'absent';

export interface VerifiableBodyRow {
  tenant_id: string;
  hmac_key_version: number;
  packet_hmac: string;
  /** Exactly the jsonb stored in `runtime_trace_bodies.packet`. */
  packet: unknown;
}

/**
 * Recompute the body's `packet_hmac` and compare.
 *
 * Works for encrypted bodies too: the writer signs the cipher-envelope metadata
 * it stores, not the plaintext, so the stored `packet` is always the signed
 * value regardless of redaction class.
 *
 * Never throws — same reasoning as `verifyEnvelopeIntegrity`.
 */
export function verifyBodyIntegrity(row: VerifiableBodyRow | null | undefined): BodyIntegrity {
  if (!row) return 'absent';
  if (typeof row.packet_hmac !== 'string' || row.packet_hmac.length === 0) {
    // The writer always signs, so a stored body with no signature is a real
    // integrity failure rather than an inability to check.
    return 'invalid';
  }
  try {
    return verifyHmac(row.tenant_id, row.hmac_key_version, row.packet, row.packet_hmac)
      ? 'verified'
      : 'invalid';
  } catch (err) {
    logger.warn(
      { err, hmac_key_version: row.hmac_key_version },
      'runtime_trace.body_verify_unavailable',
    );
    return 'unknown';
  }
}

/** Row shape needed to verify — a subset of `runtime_trace_envelopes`. */
export interface VerifiableEnvelopeRow extends EnvelopeSignedFields {
  envelope_hmac: string;
  /**
   * Issue #535 — which payload definition the writer signed, read straight off
   * the row (`envelope_payload_version`, migration 119). Typed `number`, not
   * `EnvelopePayloadVersion`: the column is a plain INTEGER and this is the
   * boundary where a value that is not a version we know has to be caught.
   */
  envelope_payload_version: number;
}

/**
 * Recompute the envelope HMAC and compare.
 *
 * Dual-version by construction (issue #535): a v1 row is re-signed with the v1
 * payload, a v2 row with the v2 payload. Envelopes written before `attempt`
 * and `root_trace_id` joined the signature therefore keep verifying exactly as
 * they did — adding a field to the signature must not retroactively convict
 * every row that predates it, which is the same reasoning that reserves
 * `unknown` for a missing key version instead of calling a rotation an attack.
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

  const payloadVersion = row.envelope_payload_version;
  if (!isKnownEnvelopePayloadVersion(payloadVersion)) {
    /**
     * A payload version this build cannot reconstruct ⇒ `invalid`, NOT
     * `unknown`. The two states answer different questions and the distinction
     * is the whole reason `unknown` exists:
     *
     *   `unknown` means "the material to check is missing HERE" — a key
     *   rotated out of this process, a reader deployed without the secret. The
     *   row is fine; this reader is under-provisioned, and the fix is config.
     *   Nothing about the row is suspicious, so accusing it would make every
     *   rotation look like an incident.
     *
     *   A payload version is not provisioned, it is WRITTEN. Only the writer
     *   sets this column, only ever to a version that existed when the row was
     *   written, and versions are added, never removed — so no legitimate row
     *   can carry a version this build does not know. A row that does is
     *   either hand-edited or produced by something that is not our writer,
     *   and both are exactly what `invalid` is for. Answering `unknown` would
     *   hand an attacker a way to opt any row out of verification by writing a
     *   number nobody has implemented yet.
     *
     * The one shape that WOULD warrant `unknown` — a NEWER version written by
     * a newer replica and read by an older one mid-deploy — is prevented
     * operationally instead: a payload version ships (readable) at least one
     * release before it is written. See `docs/runbooks/p10b-runtime-trace.md`.
     */
    logger.warn(
      {
        trace_id: row.trace_id,
        envelope_payload_version: payloadVersion,
      },
      'runtime_trace.envelope_payload_version_unknown',
    );
    return 'invalid';
  }

  try {
    const ok = verifyHmac(
      row.tenant_id,
      row.hmac_key_version,
      envelopeSignedPayload(row, payloadVersion),
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
