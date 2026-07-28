/**
 * Secret redaction for configuration output (issue #515).
 *
 * Invariant: a secret VALUE never reaches a log line, a validator message, a
 * generated artifact, a JSON payload or a Zod issue. Messages name the
 * VARIABLE and the RULE; the value is replaced by a fixed marker.
 *
 * PURE module: no side effects, no environment access.
 */
import { SECRET_NAMES, findSpec } from '@/config/contract.js';

/** Fixed marker used everywhere a secret value would otherwise appear. */
export const REDACTED = '***REDACTED***';

/** True when the variable is declared secret by the contract. */
export function isSecretVar(name: string): boolean {
  return findSpec(name)?.secret === true;
}

/** Value safe to display for `name`: secrets collapse to the marker. */
export function redactValue(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isSecretVar(name) ? REDACTED : value;
}

/**
 * Scrub any secret VALUE present in `env` out of an arbitrary string.
 *
 * Defence in depth: the validator is written never to interpolate secrets, but
 * a Zod issue message (or a third-party error) can still echo the input. This
 * is the last gate before anything is printed.
 *
 * Short values (< 4 chars) are skipped — replacing them would mangle unrelated
 * text without protecting anything meaningful.
 */
export function scrubSecrets(
  text: string,
  env: Record<string, string | undefined>,
): string {
  let out = text;
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (!value || value.length < 4) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/** A copy of `env` with every contract secret replaced by the marker. */
export function redactEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = redactValue(key, value);
  }
  return out;
}
