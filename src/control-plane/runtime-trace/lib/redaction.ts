/**
 * P10b — Redaction policy.
 *
 * `redactPacket()` strips PII from the ExecutionContextPacket while
 * preserving the structural decisions (policy_id, decision, risk score,
 * hook outputs). The redaction set is HARDCODED (Architecture Lock):
 * adding fields requires founder approval.
 *
 * Strategy (Codex review #102 — issue 5):
 *   STRICT ALLOWLIST. Only known structural keys at the top level are
 *   retained; everything else is dropped (with a counter). The previous
 *   inverted blocklist could pass unknown PII through verbatim when a
 *   caller added a new top-level field (message text, phone, tool args).
 *
 *   - `STRUCTURAL_TOP_LEVEL` — IDs and pointers, retained verbatim.
 *   - `DECISION_TOP_LEVEL`   — DecisionPacket fields, retained verbatim
 *                              (no PII by construction; these are policy
 *                              decisions, hook outputs, risk score).
 *   - `request`              — special-cased: keep `direction`, blank
 *                              every other field.
 *   - `soul` / `user_layer`  — special-cased: SHA256-summarized so drift
 *                              forensics can still detect structural changes.
 *   - ANY OTHER top-level key — DROPPED, counter incremented.
 *
 * Debug class bypasses redactPacket and goes through AES-GCM + S3/inline.
 * Minimal class is envelope-only (returns null).
 */
import { createHash } from 'node:crypto';
import type { ExecutionContextPacketStub, RedactionClass, RedactionApplied } from '../types.js';
import { logger } from '@/lib/logger.js';

/**
 * Hardcoded structural keys retained verbatim in redacted output.
 * (Architecture Lock — change requires founder approval.)
 *
 * These are all opaque IDs/pointers — no PII by definition.
 */
const STRUCTURAL_TOP_LEVEL: ReadonlySet<string> = new Set([
  'trace_id',
  'tenant_id',
  'agent_id',
  'conversa_id',
  'turno_id',
]);

/**
 * Decision-shaped top-level keys retained verbatim. These come from the
 * DecisionPacket / PEP output and are structural by construction (policy
 * decisions, hook outputs, risk scores — no user text).
 *
 * Whitelist; anything new MUST be added explicitly with a code review
 * confirming the field can never carry PII.
 */
const DECISION_TOP_LEVEL: ReadonlySet<string> = new Set([
  'decision',
  'side_effect_level',
  'policy_id',
  'policy_hooks',
  'risk_score',
  'reason_code', // structural reason code — NOT free-text reason
  'decision_meta', // safe shape: { risk_score, hook_count, ... }
  'decision_packet', // PEP output: pre-redacted DecisionPacket stub
]);

/**
 * Special-cased keys handled with custom logic.
 */
const SPECIAL_CASED: ReadonlySet<string> = new Set(['request', 'soul', 'user_layer']);

/**
 * PII fields that MUST be wiped from `request`. Allowed: only `direction`.
 */
const REQUEST_PII_FIELDS: readonly string[] = [
  'text',
  'caption',
  'media_refs',
  'transcription',
  'media_url',
  'phone',
  'sender_name',
  'reply_to',
  'tool_args',
  'attachments',
];

export interface RedactedPacket {
  packet: Record<string, unknown> | null;
  bytes_redacted: number;
  redaction_applied: RedactionApplied;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function approxBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Apply redaction policy. Returns:
 *   - For 'standard': PII-stripped packet + bytes counter.
 *   - For 'minimal': null body (envelope is enough).
 *   - For 'debug':  unredacted packet (caller MUST encrypt+upload to S3).
 *
 * Debug is gated upstream by MFA + admin role; this function does NOT
 * enforce that — it trusts the caller's permission check.
 */
export function redactPacket(
  packet: ExecutionContextPacketStub,
  redaction_class: RedactionClass,
): RedactedPacket {
  if (redaction_class === 'minimal') {
    return { packet: null, bytes_redacted: approxBytes(packet), redaction_applied: 'minimal_v1' };
  }
  if (redaction_class === 'debug') {
    // Caller path encrypts to S3/inline; we pass through.
    return {
      packet: packet as Record<string, unknown>,
      bytes_redacted: 0,
      redaction_applied: 'debug_encrypted_v1',
    };
  }
  // standard: STRICT ALLOWLIST — drop everything unknown.
  let bytes_redacted = 0;
  let dropped_unknown_count = 0;
  const out: Record<string, unknown> = {};

  // 1. Structural IDs (verbatim).
  for (const k of STRUCTURAL_TOP_LEVEL) {
    if (k in packet) out[k] = (packet as Record<string, unknown>)[k];
  }

  // 2. request: keep direction, blank PII fields. Anything else inside
  //    request is also dropped (allowlist within the sub-tree).
  const reqIn = (packet as Record<string, unknown>).request;
  if (reqIn && typeof reqIn === 'object') {
    const reqRec = reqIn as Record<string, unknown>;
    const reqOut: Record<string, unknown> = {};
    if (reqRec.direction) reqOut.direction = reqRec.direction;
    for (const k of REQUEST_PII_FIELDS) {
      if (k in reqRec) {
        bytes_redacted += approxBytes(reqRec[k]);
        reqOut[`${k}_redacted`] = true;
      }
    }
    // Drop any other request.* key with a counter (e.g. caller-injected
    // user identity fields). Mark _other_dropped so audits can spot it.
    let req_other_dropped = 0;
    for (const k of Object.keys(reqRec)) {
      if (k === 'direction') continue;
      if (REQUEST_PII_FIELDS.includes(k)) continue;
      bytes_redacted += approxBytes(reqRec[k]);
      req_other_dropped += 1;
    }
    if (req_other_dropped > 0) reqOut._other_dropped = req_other_dropped;
    out.request = reqOut;
  }

  // 3. Slices — SHA256 summarized.
  for (const sliceKey of ['soul', 'user_layer'] as const) {
    const slice = (packet as Record<string, unknown>)[sliceKey];
    if (slice !== undefined && slice !== null) {
      const json = JSON.stringify(slice);
      bytes_redacted += Buffer.byteLength(json, 'utf8');
      out[sliceKey] = { __redacted: true, sha256: sha256Hex(json), byte_len: json.length };
    }
  }

  // 4. Decision-shaped allowlist (verbatim — no PII by construction).
  for (const k of DECISION_TOP_LEVEL) {
    if (k in packet) out[k] = (packet as Record<string, unknown>)[k];
  }

  // 5. Drop everything else. This is the key fix vs. the previous blocklist:
  //    unknown top-level fields (free-text, phone numbers, tool args dumped
  //    by an unaware caller) are now DROPPED by default, not passed through.
  for (const k of Object.keys(packet)) {
    if (STRUCTURAL_TOP_LEVEL.has(k)) continue;
    if (DECISION_TOP_LEVEL.has(k)) continue;
    if (SPECIAL_CASED.has(k)) continue;
    bytes_redacted += approxBytes((packet as Record<string, unknown>)[k]);
    dropped_unknown_count += 1;
  }

  if (dropped_unknown_count > 0) {
    // Don't log values (could contain PII) — only counts. Surfaces in
    // ops dashboards so we know when callers are adding new fields that
    // SHOULD be added to the allowlist after audit.
    logger.debug(
      {
        trace_id: (packet as Record<string, unknown>).trace_id,
        dropped_unknown_count,
      },
      'runtime_trace.redaction_dropped_unknown_top_level',
    );
    out._redaction_dropped_unknown_count = dropped_unknown_count;
  }

  return { packet: out, bytes_redacted, redaction_applied: 'standard_v1' };
}
