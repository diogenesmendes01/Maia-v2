/**
 * P8.5 — Environment variable parser + feature-flag accessors.
 *
 * Validates required env vars at startup. Feature flags default to false in
 * production; enable via env (.env.local in dev).
 */
import { z } from 'zod';

const FlagSchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  NEXTAUTH_SECRET: z.string().min(8).optional(),
  NEXTAUTH_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).optional(),

  FEATURE_ADMIN_UI_V1: FlagSchema.default('false'),
  FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS: FlagSchema.default('false'),
  FEATURE_ADMIN_UI_BULK_REJECT: FlagSchema.default('true'),
  FEATURE_ADMIN_UI_REDECIDE: FlagSchema.default('false'),

  /**
   * Dev-only shared-secret token validated by the magic-link CredentialsProvider.
   * MUST be set + non-empty for the email-only stub to authorize a sign-in. In
   * production (NODE_ENV=production OR ALLOW_DEV_AUTH=false) the CredentialsProvider
   * itself is removed at construction time — see ./auth.ts.
   *
   * The token is shared (not per-user) on purpose: it gates dev access to the
   * admin UI while OIDC/SAML is wired (P10). Setting it requires shell access
   * to the deployment, which is what makes the stub fail-closed.
   */
  ADMIN_UI_DEV_LOGIN_TOKEN: z.string().min(16).optional(),

  /**
   * Explicit allow-list for the dev-only auth path. Defaults to false; must be
   * 'true' in addition to FEATURE_ADMIN_UI_V1 for the magic-link stub to load.
   * Production deployments MUST leave this false — set it only in .env.local.
   */
  ALLOW_DEV_AUTH: FlagSchema.default('false'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`P8.5 env validation failed: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
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
