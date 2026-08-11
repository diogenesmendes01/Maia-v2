import { config } from '@/config/env.js';

/**
 * True iff `tz` is a valid IANA time-zone name (e.g. 'America/Sao_Paulo',
 * 'Europe/Lisbon'). Uses the Intl time-zone database the runtime already ships
 * with — `Intl.DateTimeFormat` throws a RangeError on an unknown zone, so a
 * `try/catch` is the canonical validity probe (no extra dependency).
 */
export function isValidIanaTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The time zone to render "now" in for a given interlocutor.
 *
 * Resolution order (fail-safe — never throws):
 *   1. `pessoa.preferencias.timezone`, when it is a valid IANA name. This is set
 *      by the `set_interlocutor_timezone` tool when the person tells the agent
 *      where they are (e.g. "estou em Lisboa").
 *   2. `config.TZ` — the platform default (`America/Sao_Paulo`).
 *
 * An absent or invalid stored value silently falls back to the default, so a
 * malformed write can never break prompt assembly or reminder scheduling.
 */
export function resolveInterlocutorTz(
  pessoa: { preferencias?: unknown } | null | undefined,
): string {
  const prefs = (pessoa?.preferencias ?? {}) as Record<string, unknown>;
  const tz = prefs.timezone;
  if (typeof tz === 'string' && isValidIanaTimeZone(tz)) return tz;
  return config.TZ;
}
