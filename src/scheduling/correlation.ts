/**
 * Spec 18 §7.4 — correlation tokens for outreach disambiguation.
 *
 * Every recurring_outreach occurrence gets a 4-hex token at creation. The
 * outbound message template appends `\n\n_ref: A4F2_` (formatted via
 * WhatsApp markdown so it reads as a faint reference, not a code).
 *
 * On inbound, we look for the same pattern. If the response has it, we
 * route directly. If not, we fall back to (a) single-candidate match,
 * (b) disambiguation prompt to the owner.
 */

import { randomBytes } from 'node:crypto';

export const REF_TOKEN_REGEX = /_ref:\s*([A-F0-9]{4})_/i;
const ALPHABET = '0123456789ABCDEF';

export function newCorrelationToken(): string {
  const bytes = randomBytes(2);
  return Array.from(bytes)
    .map((b) => ALPHABET[(b >> 4) & 0xf]! + ALPHABET[b & 0xf]!)
    .join('')
    .slice(0, 4);
}

export function appendCorrelationFooter(text: string, token: string): string {
  return `${text}\n\n_ref: ${token}_`;
}

export function extractCorrelationToken(text: string): string | null {
  const m = REF_TOKEN_REGEX.exec(text);
  return m ? m[1]!.toUpperCase() : null;
}
