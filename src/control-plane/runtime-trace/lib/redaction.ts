/**
 * P10b — Redaction policy.
 *
 * `redactPacket()` strips PII from the ExecutionContextPacket while
 * preserving the structural decisions (policy_id, decision, risk score,
 * hook outputs). The redaction set is HARDCODED (Architecture Lock):
 * adding fields requires founder approval.
 *
 * Strategy (Codex review #102 — issue 5 + round-2 finding #4):
 *   STRICT ALLOWLIST at ALL levels. Only known structural keys at the top
 *   level and within decision containers are retained; everything else is
 *   dropped (with a counter). The previous implementation:
 *     1. Applied a blocklist at the top level (issue 5 fix: now allowlist).
 *     2. Copied decision containers verbatim (round-2 finding #4 — these
 *        can contain free-text reasoning or tool args dumped by the PEP).
 *   Fix: each decision container (`policy_hooks`, `decision_meta`,
 *   `decision_packet`) now has its own nested allowlist. Only audited
 *   scalars/enums/IDs survive; free-text fields are dropped by default.
 *
 *   - `STRUCTURAL_TOP_LEVEL` — IDs and pointers, retained verbatim.
 *   - `DECISION_SCALARS_TOP` — scalar/enum decision fields at top level.
 *   - `policy_hooks`         — nested allowlist (hook IDs, outcomes, codes).
 *   - `decision_meta`        — nested allowlist (scores, counts, versions).
 *   - `decision_packet`      — nested allowlist (structural PEP fields only).
 *   - `request`              — special-cased: keep `direction`, blank PII.
 *   - `soul` / `user_layer`  — special-cased: SHA256-summarized.
 *   - ANY OTHER key          — DROPPED, counter incremented.
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
 * Scalar/enum decision fields at the top level — not containers.
 * These are retained verbatim (no nested objects, no free-text).
 */
const DECISION_SCALARS_TOP: ReadonlySet<string> = new Set([
  'decision',
  'side_effect_level',
  'policy_id',
  'risk_score',
  'reason_code', // structural reason code — NOT free-text reason
]);

/**
 * Nested allowlist for `policy_hooks` values (array of hook result objects).
 * Only opaque IDs, outcome enums, and scalar codes are kept.
 * Free-text fields (reason, message, args, output) are dropped.
 *
 * Round-2 finding #4: previously copied policy_hooks verbatim; hook outputs
 * can contain tool arguments or user-visible reasoning text.
 */
const POLICY_HOOK_ALLOWED: ReadonlySet<string> = new Set([
  'hook_id',
  'hook_name',
  'outcome', // enum: 'pass' | 'fail' | 'skip'
  'error_code', // structural code — NOT free-text error message
  'duration_ms',
  'version',
]);

/**
 * Nested allowlist for `decision_meta` object.
 * Safe shape: scalar scores, counts, versions — no free-text.
 *
 * Round-2 finding #4: previously copied decision_meta verbatim; callers
 * could inject arbitrary keys (e.g. reason strings, tool args).
 */
const DECISION_META_ALLOWED: ReadonlySet<string> = new Set([
  'risk_score',
  'hook_count',
  'hook_pass_count',
  'hook_fail_count',
  'policy_version',
  'evaluation_ms',
  'tenant_overrides_count',
  'trace_id', // back-reference (opaque ID)
]);

/**
 * Nested allowlist for `decision_packet` object (PEP output stub).
 * Only structural / audit-safe fields. Free-text reasoning, tool args,
 * and any unknown keys are dropped.
 *
 * Round-2 finding #4: the prior test documented decision_packet as
 * "trusted to be pre-redacted upstream" — but that contract is not
 * enforced at the PEP boundary, reopening PII leakage through the
 * allowlisted container.
 */
const DECISION_PACKET_ALLOWED: ReadonlySet<string> = new Set([
  'decision',
  'side_effect_level',
  'policy_id',
  'policy_version',
  'risk_score',
  'reason_code', // structural code — NOT reason string
  'hook_summary', // scalar summary — NOT hook detail text
  'tenant_id', // opaque ID
  'agent_id', // opaque ID
  'trace_id', // opaque ID
  'evaluated_at', // ISO timestamp
]);

/**
 * Decision-shaped top-level CONTAINER keys (object/array).
 * These are NOT copied verbatim — each has a nested allowlist applied below.
 */
const DECISION_CONTAINERS: ReadonlySet<string> = new Set([
  'policy_hooks',
  'decision_meta',
  'decision_packet',
]);

/**
 * All decision-related top-level keys (scalars + containers).
 * Used to recognise "known" keys for the drop-unknown counter.
 */
const ALL_DECISION_TOP_LEVEL: ReadonlySet<string> = new Set([
  ...DECISION_SCALARS_TOP,
  ...DECISION_CONTAINERS,
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

  // 4. Scalar decision fields (verbatim — these are primitive enums/IDs).
  for (const k of DECISION_SCALARS_TOP) {
    if (k in packet) out[k] = (packet as Record<string, unknown>)[k];
  }

  // 5. Decision CONTAINERS — schema-driven nested allowlist (round-2 #4 fix).
  //    Each container is filtered to its own allowlist; unknown nested keys
  //    (free-text reason, tool args, hook output, etc.) are dropped.
  //    Previously these were copied verbatim, which reopened PII leakage
  //    through an allowlisted top-level key.

  // 5a. policy_hooks — array of hook result objects.
  const hooksRaw = (packet as Record<string, unknown>).policy_hooks;
  if (hooksRaw !== undefined && hooksRaw !== null) {
    if (Array.isArray(hooksRaw)) {
      out.policy_hooks = (hooksRaw as unknown[]).map((hook) => {
        if (typeof hook !== 'object' || hook === null) return {};
        const hookRec = hook as Record<string, unknown>;
        const filtered: Record<string, unknown> = {};
        let hook_dropped = 0;
        for (const k of Object.keys(hookRec)) {
          if (POLICY_HOOK_ALLOWED.has(k)) {
            filtered[k] = hookRec[k];
          } else {
            bytes_redacted += approxBytes(hookRec[k]);
            hook_dropped += 1;
          }
        }
        if (hook_dropped > 0) filtered._nested_dropped = hook_dropped;
        return filtered;
      });
    } else {
      // Non-array policy_hooks is unexpected — drop and count.
      bytes_redacted += approxBytes(hooksRaw);
      dropped_unknown_count += 1;
    }
  }

  // 5b. decision_meta — flat object of scalar audit metadata.
  const metaRaw = (packet as Record<string, unknown>).decision_meta;
  if (metaRaw !== undefined && metaRaw !== null) {
    if (typeof metaRaw === 'object' && !Array.isArray(metaRaw)) {
      const metaRec = metaRaw as Record<string, unknown>;
      const filteredMeta: Record<string, unknown> = {};
      let meta_dropped = 0;
      for (const k of Object.keys(metaRec)) {
        if (DECISION_META_ALLOWED.has(k)) {
          filteredMeta[k] = metaRec[k];
        } else {
          bytes_redacted += approxBytes(metaRec[k]);
          meta_dropped += 1;
        }
      }
      if (meta_dropped > 0) filteredMeta._nested_dropped = meta_dropped;
      out.decision_meta = filteredMeta;
    } else {
      bytes_redacted += approxBytes(metaRaw);
      dropped_unknown_count += 1;
    }
  }

  // 5c. decision_packet — PEP output stub (structural fields only).
  const pktRaw = (packet as Record<string, unknown>).decision_packet;
  if (pktRaw !== undefined && pktRaw !== null) {
    if (typeof pktRaw === 'object' && !Array.isArray(pktRaw)) {
      const pktRec = pktRaw as Record<string, unknown>;
      const filteredPkt: Record<string, unknown> = {};
      let pkt_dropped = 0;
      for (const k of Object.keys(pktRec)) {
        if (DECISION_PACKET_ALLOWED.has(k)) {
          filteredPkt[k] = pktRec[k];
        } else {
          bytes_redacted += approxBytes(pktRec[k]);
          pkt_dropped += 1;
        }
      }
      if (pkt_dropped > 0) filteredPkt._nested_dropped = pkt_dropped;
      out.decision_packet = filteredPkt;
    } else {
      bytes_redacted += approxBytes(pktRaw);
      dropped_unknown_count += 1;
    }
  }

  // 6. Drop everything else. Unknown top-level fields (free-text, phone
  //    numbers, tool args dumped by an unaware caller) are DROPPED by default.
  for (const k of Object.keys(packet)) {
    if (STRUCTURAL_TOP_LEVEL.has(k)) continue;
    if (ALL_DECISION_TOP_LEVEL.has(k)) continue;
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
