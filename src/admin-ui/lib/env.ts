/**
 * Admin UI environment accessor.
 *
 * Issue #515 — this file USED to carry a second, independent Zod schema. Two
 * schemas meant the Admin UI and the runtime could disagree about what a
 * variable means, what it defaults to, and whether it is required — and the
 * duplicate had no consumers, so nobody would notice the divergence until an
 * operator did, in production.
 *
 * It is now a thin adapter over the single canonical contract:
 *   - the schema comes from `objectSchemaForService('admin-ui')`, i.e. exactly
 *     the subset of `src/config/contract.ts` this service is allowed to read;
 *   - `docs/configuration.md` and `.env.example` document the same variables
 *     from the same source;
 *   - `npm run config:check` validates an Admin UI `.env` with the same rules.
 *
 * Deliberately imports ONLY `@/config/contract.js` (which imports only `zod`),
 * so this module stays safe to pull into any Next.js build target.
 */
import { objectSchemaForService } from '@/config/contract.js';

const envSchema = objectSchemaForService('admin-ui');

export type Env = ReturnType<typeof envSchema.parse>;

let cached: Env | null = null;

/**
 * Parsed Admin UI configuration. Throws on invalid configuration — fail
 * closed, never a silent default. Cached because the process environment does
 * not change under a running Next.js server.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Message only — Zod issue messages name the variable and the constraint,
    // never the value. See src/config/redact.ts for the shared guarantee.
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Admin UI env validation failed (contrato #515): ${detail}`);
  }
  cached = parsed.data as Env;
  return cached;
}

/** Test seam: drop the memoised parse so a spec can flip env vars in-process. */
export function _resetEnvCacheForTests(): void {
  cached = null;
}

export type FeatureFlag =
  | 'FEATURE_ADMIN_UI_V1'
  | 'FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS'
  | 'FEATURE_ADMIN_UI_BULK_REJECT'
  | 'FEATURE_ADMIN_UI_REDECIDE';

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return getEnv()[flag] === true;
}

export function requireFlag(flag: FeatureFlag): void {
  if (!isFeatureEnabled(flag)) {
    throw new Error(`Feature ${flag} is not enabled`);
  }
}
