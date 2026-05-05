/**
 * Centralized sanitization and wrapping utilities for untrusted text content.
 * Prevents prompt injection by escaping literal closing tags that could let
 * an attacker break out of a wrapper block.
 */

const PROTECTED_TAGS = ['user_message', 'ocr', 'audio_transcript', 'fact', 'rule'] as const;

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
