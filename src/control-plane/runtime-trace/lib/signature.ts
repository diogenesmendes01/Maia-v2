/**
 * Runtime-trace envelope signature — VERSIONED canonical material.
 *
 * Issue #535, owner decision: sign `root_trace_id` and `attempt` before the
 * first production trace exists. Migration 107 left both OUTSIDE
 * `envelope_hmac` on the argument that re-signing would invalidate every
 * envelope already written; the flag that writes them
 * (`FEATURE_RUNTIME_TRACE_V1`) has never been on in production, so there is no
 * corpus to invalidate and this is the last cheap moment to fix the contract.
 *
 * Two versions, one file, on purpose: a signer and a verifier that build the
 * signed bytes in two places drift, and a drifted verifier reports tampering
 * that never happened (or misses tampering that did).
 *
 *   v1 — the migration-052/107 field set. NOT written any more (see
 *        `envelope-writer.ts`); still VERIFIABLE so fixtures and environments
 *        that already hold v1 rows keep a real integrity verdict instead of a
 *        blanket "invalid".
 *   v2 — v1 ∪ { `root_trace_id`, `attempt`, `signature_version` }. Written by
 *        every production path.
 *
 * ## Why `signature_version` is itself inside the v2 material
 *
 * The version lives in a DB column, and a column is exactly what an attacker
 * with write access controls. If the v2 material did not name its own version,
 * the two versions would be two *unlabelled* encodings of overlapping field
 * sets and the verifier's choice between them would rest entirely on an
 * attacker-supplied integer.
 *
 * Signing the version is the domain separation that makes the choice safe:
 * HMAC(v2 material) ≠ HMAC(v1 material) for the same row, always, because the
 * v2 material carries `"signature_version":2` and the v1 material carries no
 * such key. So flipping the stored `signature_version` from 2 to 1 — the
 * downgrade move, whose payoff would be escaping the two new fields — makes the
 * verifier recompute the v1 material and compare it against an HMAC taken over
 * the v2 material. It does not match. The row reads `invalid`, which is the
 * correct verdict for a row that was tampered with.
 *
 * What signing the version does NOT buy: a genuinely v1-signed row still has
 * `root_trace_id`/`attempt` outside its signature, so those two columns remain
 * editable-without-detection ON V1 ROWS. That is why v1 acceptance is a read
 * side switch (`RUNTIME_TRACE_ACCEPT_SIGNATURE_V1`) and why `listAttempts()`
 * additionally requires the SIGNED `turno_id` — see
 * `src/db/repositories/runtime-trace-repos.ts`.
 *
 * ## Encoding ambiguity
 *
 * The canonical encoding is `canonicalJson` (`lib/hmac.ts`): recursive
 * key-sorted JSON, with `JSON.stringify` applied to every key and every string
 * value. It is NOT separator-concatenation, so the classic forgery — a field
 * value that contains the delimiter and re-parses as a different field split —
 * has no purchase: a `"`, `,`, `:`, `{` or `}` inside a value comes out escaped
 * and can never close its own string.
 * `tests/unit/observability/envelope-signature-v2.spec.ts` pins that with
 * adversarial values rather than leaving it as an assertion in a comment.
 *
 * The one encoding rule this file must uphold itself: every optional field is
 * normalised to `null`, never left `undefined`. `canonicalJson` DROPS an
 * `undefined` object entry, so an `undefined` here would silently remove a key
 * from the signed bytes and let two different envelopes share one material.
 * Hence the `?? null` on every nullable field below.
 */

/** The field set migrations 052/107 signed. Kept verifiable, never written. */
export const ENVELOPE_SIGNATURE_V1 = 1;
/** v1 ∪ { root_trace_id, attempt, signature_version }. Written by production. */
export const ENVELOPE_SIGNATURE_V2 = 2;

export type EnvelopeSignatureVersion = 1 | 2;

/**
 * The version every production write uses. There is exactly one writer path and
 * it reads this constant — see `envelope-writer.ts`.
 */
export const CURRENT_ENVELOPE_SIGNATURE_VERSION: EnvelopeSignatureVersion = 2;

export const SUPPORTED_ENVELOPE_SIGNATURE_VERSIONS: readonly EnvelopeSignatureVersion[] = [
  1, 2,
];

export function isSupportedSignatureVersion(v: unknown): v is EnvelopeSignatureVersion {
  return v === ENVELOPE_SIGNATURE_V1 || v === ENVELOPE_SIGNATURE_V2;
}

/**
 * Fields covered by v1. Deliberately its own type: it is the shape of a FROZEN
 * legacy encoding, and adding a field to it would silently invalidate every v1
 * row it exists to keep verifiable.
 */
export interface EnvelopeSignedFieldsV1 {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversa_id: string | null;
  turno_id: string | null;
  policy_id: string | null;
  decision: string;
  side_effect_level: string;
  redaction_class: string;
  hmac_key_version: number;
}

/** Fields covered by v2. */
export interface EnvelopeSignedFieldsV2 extends EnvelopeSignedFieldsV1 {
  /** Root trace id of the turn — equal to `trace_id` on attempt 1. */
  root_trace_id: string | null;
  /** 1-based attempt ordinal. */
  attempt: number;
}

/** Everything a verifier may need, whichever version the row claims. */
export type EnvelopeSignedFields = EnvelopeSignedFieldsV2;

/** Writer and verifier must clamp identically; one function, both callers. */
export function normalizeAttempt(attempt: number | null | undefined): number {
  const n = Number(attempt ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

/** Canonical material for v1. Frozen — do not add fields. */
export function envelopeSignedPayloadV1(
  fields: EnvelopeSignedFieldsV1,
): Record<string, unknown> {
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

/**
 * Canonical material for v2.
 *
 * `attempt` is normalised exactly the way the writer clamps it, so signer and
 * verifier cannot disagree over a value the DB CHECK constraint would have
 * rejected anyway.
 */
export function envelopeSignedPayloadV2(
  fields: EnvelopeSignedFieldsV2,
): Record<string, unknown> {
  return {
    ...envelopeSignedPayloadV1(fields),
    root_trace_id: fields.root_trace_id ?? null,
    attempt: normalizeAttempt(fields.attempt),
    // Domain separation — see the module docstring. This is the field that
    // makes a stored-version flip detectable instead of free.
    signature_version: ENVELOPE_SIGNATURE_V2,
  };
}

/**
 * Build the canonical material for `version`.
 *
 * Throws for an unsupported version rather than falling back to v1: a silent
 * fallback would turn "this row claims a version we do not know" — which is
 * either a future writer or a tampered column — into a v1 verification, and a
 * v1 verification is precisely the downgrade this design refuses.
 */
export function envelopeSignedPayload(
  fields: EnvelopeSignedFields,
  version: EnvelopeSignatureVersion,
): Record<string, unknown> {
  if (version === ENVELOPE_SIGNATURE_V1) return envelopeSignedPayloadV1(fields);
  if (version === ENVELOPE_SIGNATURE_V2) return envelopeSignedPayloadV2(fields);
  throw new Error(
    `runtime_trace: unsupported envelope signature_version=${String(version)} ` +
      `(supported: ${SUPPORTED_ENVELOPE_SIGNATURE_VERSIONS.join(', ')})`,
  );
}
