/**
 * Tiny conditional-classname join. Avoids pulling clsx/tailwind-merge into
 * the bundle for what the design system actually needs.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
