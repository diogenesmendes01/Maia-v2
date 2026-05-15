/**
 * Centralized sanitization and wrapping utilities for untrusted text content.
 * Prevents prompt injection by escaping literal closing tags that could let
 * an attacker break out of a wrapper block.
 *
 * Strategy for OCR/Vision fields:
 * - (A) Structured fields (documento, CNPJ, código_barras, etc.) are validated
 *       against strict regex. If invalid, dropped (undefined). This prevents
 *       malicious strings.
 * - (B) Free-text fields (nome, banco_origem, etc.) are wrapped in <ocr> tags
 *       and sanitized via sanitizeBlock.
 */

const PROTECTED_TAGS = [
  'user_message',
  'ocr',
  'audio_transcript',
  'fact',
  'rule',
  'memory',
  'hint',
] as const;

/**
 * Sanitizes text by replacing literal closing tags that would let an attacker
 * break out of a wrapper. For example, `</audio_transcript>` becomes `</audio_transcript_>`.
 *
 * @param text The untrusted text content (may come from OCR, Whisper, user input, etc.)
 * @returns Sanitized text safe to wrap inside a tag
 */
export function sanitizeBlock(text: string): string {
  let out = text ?? '';
  for (const tag of PROTECTED_TAGS) {
    out = out.split(`</${tag}>`).join(`</${tag}_>`);
  }
  return out;
}

/**
 * Wraps sanitized text in a tag with closing tag.
 * @param text The text to wrap
 * @param tag The tag name (e.g., 'audio_transcript', 'ocr')
 * @returns The wrapped and sanitized text
 */
export function wrapWithTag(text: string, tag: 'audio_transcript' | 'ocr'): string {
  return `<${tag}>${sanitizeBlock(text)}</${tag}>`;
}

/**
 * Validates a string against a regex and drops it (returns undefined) if invalid.
 * Used for structured OCR fields (documento, código_barras, etc.) where format
 * is strictly defined. If the Vision model returns something malformed, discarding
 * it is better than propagating invalid data.
 *
 * @param text The untrusted text (may come from OCR/Vision)
 * @param re The validation regex
 * @returns The text if valid according to regex, undefined otherwise
 */
export function validateOrDrop(text: string | undefined, re: RegExp): string | undefined {
  if (typeof text !== 'string') return undefined;
  return re.test(text) ? text : undefined;
}

/**
 * Regex patterns for validating OCR-extracted structured fields.
 * These are deliberately strict to reject malformed input from Vision.
 */
export const OCR_REGEXES = {
  // CPF: 11 digits, optionally formatted with . and -
  // Patterns: 12345678901, 123.456.789-01
  cpf_or_cnpj: /^[\d.\-/]{11,18}$/,

  // Boleto código de barras: exactly 44 digits
  codigo_barras: /^\d{44}$/,

  // Boleto linha digitável: 47 digits, spaces, and dots
  // Formats like "1234.5678 9012.345678 9012.345678 1 90123456789012"
  linha_digitavel: /^[\d\s.]{40,60}$/,

  // Date: ISO format YYYY-MM-DD or BR format DD/MM/YYYY
  data: /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/,

  // End-to-end ID: alphanumeric, max 40 chars
  end_to_end_id: /^[A-Za-z0-9]{1,40}$/,

  // Banco código: 1-4 digits
  banco_codigo: /^\d{1,4}$/,
} as const;
