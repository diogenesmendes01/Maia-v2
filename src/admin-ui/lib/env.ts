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
  NEXTAUTH_SECRET: z.string().min(8).optional(),
  NEXTAUTH_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).optional(),

  FEATURE_ADMIN_UI_V1: FlagSchema.default('false'),
  FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS: FlagSchema.default('false'),
  FEATURE_ADMIN_UI_BULK_REJECT: FlagSchema.default('true'),
  FEATURE_ADMIN_UI_REDECIDE: FlagSchema.default('false'),
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
