/**
 * Schema/migration compatibility gate — issue #512 §2 (`/readyz`: "schema/
 * migration version é compatível"), rebuilt on the #516 migration contract.
 *
 * OUT OF SCOPE by design: applying migrations. Readiness NEVER runs DDL — it
 * only refuses to serve traffic on a schema the running code was not built
 * for. A process that boots against a database missing the migration its code
 * expects would fail at the first query of a new column; failing at the
 * readiness gate instead keeps the load balancer from ever routing to it.
 *
 * WHAT CHANGED IN #516. The check used to be a single comparison — "is the
 * newest file on disk the newest id in `schema_migrations`?". That answered
 * `ok` in three states it should not have:
 *
 *   - a migration in the MIDDLE of the chain was never applied (head matched,
 *     the column the code needs did not exist);
 *   - an already-applied migration had been EDITED (same filename, different
 *     bytes, different schema);
 *   - a no-transaction migration had crashed and left DIRTY state, which the
 *     head comparison read as plain success.
 *
 * It now evaluates the full ledger against the packaged artifact through
 * `evaluateCompatibility()` — the same pure function `maia migrate status` and
 * `maia doctor` (#517) use, so the probe, the CLI and the doctor can never
 * disagree about whether a database is compatible.
 *
 * Everything here is cached: the artifact for the process lifetime (files
 * cannot change under a running build) and the evaluation for
 * `SCHEMA_CHECK_CACHE_MS`, so an aggressive load-balancer poll never turns
 * into a query-per-request.
 */
import { sql } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { setGaugeProvider } from '@/lib/metrics.js';
import { defaultMigrationsDir, discoverMigrations, expectedHead } from '@/migrations/discover.js';
import { evaluateCompatibility, firstBlocker } from '@/migrations/compatibility.js';
import { mapLedgerRow } from '@/migrations/ledger.js';
import { BLOCKS_READINESS, type DiscoveredMigration, type DriftCode, type SchemaCounters } from '@/migrations/types.js';

export type SchemaVersionResult = {
  status: 'ok' | 'pending' | 'unknown';
  expected?: string;
  applied?: string;
  /** Machine-readable reason. Stable contract shared with `maia doctor`. */
  code?: DriftCode;
  /** SANITIZED, safe to return on a public probe. */
  detail?: string;
  counters?: SchemaCounters;
};

/** Schema does not move under a running process; 60s is generous. */
const SCHEMA_CHECK_CACHE_MS = 60_000;

let artifactCache: DiscoveredMigration[] | null | undefined;
let lastResult: SchemaVersionResult | null = null;
let lastCheckedAt = 0;
let gaugesRegistered = false;

/**
 * The migration artifact shipped with this build. Cached; `null` when the
 * directory is unreadable (e.g. a container that ships `dist/` without
 * `migrations/`), in which case the check reports `unknown` rather than
 * inventing an answer.
 */
function artifact(): DiscoveredMigration[] | null {
  if (artifactCache !== undefined) return artifactCache;
  try {
    artifactCache = discoverMigrations(defaultMigrationsDir());
  } catch {
    artifactCache = null;
  }
  return artifactCache;
}

/** Newest forward migration file on disk. */
export function expectedSchemaVersion(): string | null {
  const migrations = artifact();
  return migrations ? expectedHead(migrations) : null;
}

/**
 * Gauges for `/metrics`. Registered on first use rather than at import time so
 * this module stays side-effect free to import (the CLI and the tests pull the
 * compatibility helpers in without wanting a metrics registration).
 *
 * They read the LAST cached result — never a fresh query — so a Prometheus
 * scrape can never turn into database load.
 */
function registerGauges(): void {
  if (gaugesRegistered) return;
  gaugesRegistered = true;
  setGaugeProvider('maia_schema_compatible', () => (lastResult?.status === 'ok' ? 1 : 0));
  setGaugeProvider('maia_schema_pending_count', () => lastResult?.counters?.pending_count ?? 0);
  setGaugeProvider('maia_schema_dirty_count', () => lastResult?.counters?.dirty_count ?? 0);
  setGaugeProvider('maia_schema_failed_count', () => lastResult?.counters?.failed_count ?? 0);
  setGaugeProvider(
    'maia_schema_checksum_mismatch_count',
    () => lastResult?.counters?.mismatch_count ?? 0,
  );
}

export async function checkSchemaVersion(): Promise<SchemaVersionResult> {
  registerGauges();
  const now = Date.now();
  if (lastResult && now - lastCheckedAt < SCHEMA_CHECK_CACHE_MS) return lastResult;

  const migrations = artifact();
  if (!migrations || migrations.length === 0) {
    lastResult = { status: 'unknown', detail: 'migrations directory not readable' };
    lastCheckedAt = now;
    return lastResult;
  }
  const expected = expectedHead(migrations) ?? undefined;

  try {
    // READ-ONLY, one round trip. `SELECT *` on purpose: it works against a v1
    // ledger (no status/checksum columns) as well as v2, and `mapLedgerRow`
    // fills the gaps — a database that has not applied migration 110 yet must
    // still get an honest answer.
    const raw = await db.execute<Record<string, unknown>>(sql`SELECT * FROM schema_migrations`);
    // drizzle's node-postgres driver returns a pg QueryResult; be tolerant of
    // the array-like shape used by other drivers so this never throws.
    const list =
      (Array.isArray(raw) ? raw : (raw as { rows?: Record<string, unknown>[] }).rows) ?? [];
    const rows = list.map((r) => mapLedgerRow(r));

    const compat = evaluateCompatibility({
      migrations,
      rows,
      minSupported: config.MIGRATION_MIN_SUPPORTED ?? null,
      maxSupported: config.MIGRATION_MAX_SUPPORTED ?? null,
    });

    if (compat.compatible) {
      lastResult = {
        status: 'ok',
        ...(expected ? { expected } : {}),
        ...(compat.applied_head ? { applied: compat.applied_head } : {}),
        counters: compat.counters,
      };
    } else {
      const blocker = firstBlocker(compat, BLOCKS_READINESS);
      lastResult = {
        // `pending` is the not-ready signal `/readyz` and the boot step both
        // understand; the `code` field carries WHICH kind of not-ready it is.
        status: 'pending',
        ...(expected ? { expected } : {}),
        ...(compat.applied_head ? { applied: compat.applied_head } : {}),
        ...(blocker ? { code: blocker.code, detail: blocker.detail } : {}),
        counters: compat.counters,
      };
    }
  } catch (err) {
    // Raw driver text never leaves this module (issue #512: "Raw errors,
    // secrets e paths internos não aparecem em health público").
    logger.warn({ err: (err as Error).message }, 'lifecycle.schema_version_query_failed');
    lastResult = {
      status: 'unknown',
      ...(expected ? { expected } : {}),
      detail: 'schema version query failed',
    };
  }
  lastCheckedAt = now;
  return lastResult;
}

/** Test seam — clears both caches. */
export function _resetSchemaVersionCacheForTests(): void {
  artifactCache = undefined;
  lastResult = null;
  lastCheckedAt = 0;
}
