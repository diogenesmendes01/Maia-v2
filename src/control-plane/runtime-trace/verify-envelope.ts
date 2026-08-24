/**
 * Issue #514 §7 / review round 1 [P2] — real integrity verification for the
 * Trace Explorer.
 *
 * The previous revision reported `envelope_signed: envelope_hmac.length > 0`.
 * That is worse than showing nothing: a tampered envelope was presented to the
 * operator as "signed", and an operator makes decisions on that during an
 * incident. Either verify the signature or say you could not.
 *
 * Outcomes, deliberately distinct:
 *
 *   - `verified` — the HMAC recomputes over the row's own fields, under the
 *     version the row declares. The row has not been altered since it was
 *     written.
 *   - `invalid`  — it does NOT recompute. Either a field was changed or the
 *     signature was. Treat as an integrity incident.
 *   - `unknown`  — verification could not run: the master secret for that key
 *     version is not configured in THIS process (a rotated-out key, a reader
 *     deployed without the secret). Absence of proof is not proof of absence,
 *     so this must never be collapsed into `invalid`.
 *   - `rejected_version` — issue #535. The row declares a signature version
 *     this deployment refuses to accept (today: v1, when
 *     `RUNTIME_TRACE_ACCEPT_SIGNATURE_V1=false`) or a version it does not know
 *     at all. Kept apart from both `invalid` and `unknown` because it is a
 *     POLICY verdict, not evidence about the row: the signature may well be
 *     genuine, and saying "invalid" about a genuine v1 envelope would be the
 *     same category error the length check made, in the other direction.
 *
 * ## Issue #535 — reading two versions without opening a downgrade
 *
 * The version comes from the `signature_version` COLUMN, which is exactly what
 * an attacker with DB write access controls. The reason that is not a downgrade
 * oracle is that v2 signs its own version (see `lib/signature.ts`): flipping a
 * v2 row's column to 1 makes this function recompute the v1 material and
 * compare it against an HMAC taken over the v2 material, which cannot match.
 * The row reads `invalid`, which is correct — that row WAS tampered with.
 *
 * What remains, and is a real residual risk rather than a solved one: a
 * genuinely v1-signed row leaves `root_trace_id`/`attempt` outside its
 * signature, so on such a row those two columns can still be edited without
 * detection. Production no longer writes v1, so this is bounded to fixtures and
 * to environments that already hold v1 rows — and it is why
 * `RUNTIME_TRACE_ACCEPT_SIGNATURE_V1` exists and why `listAttempts()` requires
 * the SIGNED `turno_id` regardless of version.
 */
import { verifyHmac } from './lib/hmac.js';
import {
  ENVELOPE_SIGNATURE_V1,
  ENVELOPE_SIGNATURE_V2,
  envelopeSignedPayload,
  isSupportedSignatureVersion,
  type EnvelopeSignedFields,
} from './lib/signature.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';

export type EnvelopeIntegrity = 'verified' | 'invalid' | 'unknown' | 'rejected_version';

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
 * Adds a state the envelope does not need: `absent`, for a body that has not
 * been persisted yet (`body_status: 'pending'`). Nothing to verify is not the
 * same as failing to verify, and neither is the same as invalid.
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

/**
 * Row shape needed to verify — a subset of `runtime_trace_envelopes`.
 *
 * `signature_version` is optional in the TYPE only so a caller reading a table
 * that predates migration 119 still compiles; an absent value is treated as v1,
 * which is what such a row actually is.
 */
export interface VerifiableEnvelopeRow extends EnvelopeSignedFields {
  envelope_hmac: string;
  signature_version?: number | null;
}

/**
 * Is this deployment willing to verify a v1 envelope at all?
 *
 * Default TRUE: the owner decision is explicitly "the verifier keeps reading v1
 * for fixtures and old environments", and a reader that flipped every legacy
 * row to `rejected_version` on the day it deployed would destroy exactly the
 * evidence the switch is meant to protect. Turning it OFF is the operator lever
 * for an environment that has been confirmed to hold no genuine v1 rows.
 *
 * Read per call rather than cached: this is a read path, not the <20ms writer
 * hot path, and an operator flipping the switch during an incident should not
 * have to restart the process to see it take effect.
 */
function acceptsSignatureV1(): boolean {
  return config.RUNTIME_TRACE_ACCEPT_SIGNATURE_V1 !== false;
}

/**
 * Resolve the version the row claims, or `null` when it must be refused.
 *
 * A missing/null column means "written before migration 119", i.e. v1 — the
 * column's DB default says the same thing, and agreeing with it here keeps a
 * mid-migration read from inventing a v2 verdict for a v1 row.
 */
function resolveSignatureVersion(raw: number | null | undefined): 1 | 2 | null {
  const claimed = raw === null || raw === undefined ? ENVELOPE_SIGNATURE_V1 : Number(raw);
  if (!isSupportedSignatureVersion(claimed)) return null;
  if (claimed === ENVELOPE_SIGNATURE_V1 && !acceptsSignatureV1()) return null;
  return claimed as 1 | 2;
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

  const version = resolveSignatureVersion(row.signature_version);
  if (version === null) {
    logger.warn(
      {
        trace_id: row.trace_id,
        signature_version: row.signature_version ?? ENVELOPE_SIGNATURE_V1,
        accepts_v1: acceptsSignatureV1(),
      },
      'runtime_trace.envelope_signature_version_rejected',
    );
    return 'rejected_version';
  }

  try {
    const ok = verifyHmac(
      row.tenant_id,
      row.hmac_key_version,
      envelopeSignedPayload(row, version),
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

/**
 * True when the envelope's signature actually covers `root_trace_id`/`attempt`.
 *
 * The Explorer uses this to say WHY an attempt group is trustworthy (or only
 * partly so) instead of leaving the operator to infer it from a version number.
 */
export function attemptGroupingIsSigned(row: { signature_version?: number | null }): boolean {
  const raw = row.signature_version;
  const claimed = raw === null || raw === undefined ? ENVELOPE_SIGNATURE_V1 : Number(raw);
  return claimed >= ENVELOPE_SIGNATURE_V2;
}
