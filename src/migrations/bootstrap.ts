/**
 * Wiring between the migrator's configuration subset (#515) and the runner
 * (#516).
 *
 * The migrator loads `loadMigrationConfig()`, NOT `@/config/env.js`: the
 * per-service manifest deliberately withholds the LLM keys, the WhatsApp
 * session directory, the S3 backup credentials and the NextAuth secret from
 * this process. A migration container that leaks cannot leak what it was never
 * given — and `tests/unit/config/service-manifest.spec.ts` pins that subset.
 *
 * Side-effect free at import time: the pool is created only when a caller asks
 * for one, and `process.env` is read at CALL time by the loader.
 */
import pg from 'pg';
import { loadMigrationConfig, type MigrationConfig } from '@/config/migration-config.js';
import type { RunnerOptions } from './runner.js';
import type { MigrationLogger } from './log.js';

/**
 * A pool sized for a one-shot migrator: two connections (the dedicated
 * lock-holding client plus headroom for a read-only `plan`), an explicit
 * `application_name` so `pg_stat_activity` names the culprit during an
 * incident, and no idle reaping surprises mid-migration.
 */
export function createMigrationPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 2,
    application_name: 'maia-migrator',
    // A migration can legitimately run for minutes; the per-statement budget
    // is enforced by the runner via `statement_timeout`, not by the pool.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Load + validate the migrator's configuration. Throws `ConfigValidationError`. */
export function loadMigratorConfig(env?: Record<string, string | undefined>): MigrationConfig {
  return loadMigrationConfig(env ? { env } : {});
}

/** Map the validated configuration onto runner options. */
export function runnerOptionsFrom(
  config: MigrationConfig,
  pool: pg.Pool,
  logger?: MigrationLogger,
): RunnerOptions {
  return {
    pool,
    ...(logger ? { logger } : {}),
    lockTimeoutMs: config.MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: config.MIGRATION_STATEMENT_TIMEOUT_MS,
    appVersion: config.MAIA_BUILD_COMMIT ?? null,
    minSupported: config.MIGRATION_MIN_SUPPORTED ?? null,
    maxSupported: config.MIGRATION_MAX_SUPPORTED ?? null,
  };
}

/**
 * Run `fn` with a configured pool, closing it in `finally` on success AND on
 * failure — issue #516 acceptance: "`maia migrate up` fecha conexões em
 * sucesso e falha". The runner core never ends a pool it did not open, so this
 * is the single place that owns that lifecycle.
 */
export async function withMigrationRunner<T>(
  fn: (options: RunnerOptions, config: MigrationConfig) => Promise<T>,
  overrides: { env?: Record<string, string | undefined>; logger?: MigrationLogger } = {},
): Promise<T> {
  const config = loadMigratorConfig(overrides.env);
  const pool = createMigrationPool(config.DATABASE_URL);
  try {
    return await fn(runnerOptionsFrom(config, pool, overrides.logger), config);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
