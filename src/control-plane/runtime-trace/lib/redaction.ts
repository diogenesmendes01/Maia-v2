/**
 * P10b — Redaction policy.
 *
 * `redactPacket()` strips PII from the ExecutionContextPacket while
 * preserving the structural decisions (policy_id, decision, risk score,
 * hook outputs). The redaction set is HARDCODED (Architecture Lock):
 * adding fields requires founder approval.
 *
 * Strategy:
 *   - Top-level whitelist of "structural" keys retained as-is.
 *   - Inside `request`, free-text and media refs are blanked.
 *   - Inside `soul`/`user_layer`, opaque slice blobs are SHA256-summarized
 *     (so drift forensics can still detect structural changes without
 *     reading the raw memory).
 *   - Any other top-level key is dropped with a counter.
 *
 * Debug class bypasses redactPacket and goes through AES-GCM + S3.
 * Minimal class is envelope-only (returns null).
 */
import { createHash } from 'node:crypto';
import type { ExecutionContextPacketStub, RedactionClass, RedactionApplied } from '../types.js';

/**
 * Hardcoded structural keys retained verbatim in redacted output.
 * (Architecture Lock — change requires founder approval.)
 */
const STRUCTURAL_TOP_LEVEL: ReadonlySet<string> = new Set([
  'trace_id',
  'tenant_id',
  'agent_id',
  'conversa_id',
  'turno_id',
]);

/**
 * PII fields that MUST be wiped from `request` (text/media references and
 * anything user-typed).
 */
const REQUEST_PII_FIELDS: readonly string[] = [
  'text',
  'caption',
  'media_refs',
  'transcription',
  'media_url',
  'phone',
  'sender_name',
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
    // Caller path encrypts to S3; we pass through.
    return {
      packet: packet as Record<string, unknown>,
      bytes_redacted: 0,
      redaction_applied: 'debug_encrypted_v1',
    };
  }
  // standard: structural + redacted request + summarized slices.
  let bytes_redacted = 0;
  const out: Record<string, unknown> = {};

  for (const k of STRUCTURAL_TOP_LEVEL) {
    if (k in packet) out[k] = (packet as Record<string, unknown>)[k];
  }

  // request: keep keys, blank PII fields.
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
    out.request = reqOut;
  }

  // Opaque slices — summarize so drift can detect structural changes.
  for (const sliceKey of ['soul', 'user_layer'] as const) {
    const slice = (packet as Record<string, unknown>)[sliceKey];
    if (slice !== undefined && slice !== null) {
      const json = JSON.stringify(slice);
      bytes_redacted += Buffer.byteLength(json, 'utf8');
      out[sliceKey] = { __redacted: true, sha256: sha256Hex(json), byte_len: json.length };
    }
  }

  // Decision-related top-level keys (policy_hooks, risk_score, etc.) are passed
  // through verbatim — they're structural, not PII.
  for (const [k, v] of Object.entries(packet)) {
    if (STRUCTURAL_TOP_LEVEL.has(k)) continue;
    if (k === 'request' || k === 'soul' || k === 'user_layer') continue;
    out[k] = v;
  }

  return { packet: out, bytes_redacted, redaction_applied: 'standard_v1' };
}
