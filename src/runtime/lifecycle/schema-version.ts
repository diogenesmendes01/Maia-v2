/**
 * Schema/migration version compatibility — issue #512 §2 (`/readyz`:
 * "schema/migration version é compatível") and §4 step 4.
 *
 * OUT OF SCOPE by design: applying migrations. Readiness NEVER runs DDL — it
 * only refuses to serve traffic on a schema the running code was not built
 * for. A process that boots against a database missing the migration its code
 * expects would fail at the first query of a new column; failing at the
 * readiness gate instead keeps the load balancer from ever routing to it.
 *
 * "Expected" is the newest forward migration file on disk (`migrations/`,
 * mirroring `scripts/migrate.ts`: `.sql`, excluding `_down.sql`). "Applied" is
 * the newest id in `schema_migrations`. Both are read-only.
 *
 * Everything here is cached: the expected value for the process lifetime (the
 * files cannot change under a running build) and the applied value for
 * `SCHEMA_CHECK_CACHE_MS`, so an aggressive load-balancer poll never turns
 * into a query-per-request.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';

export type SchemaVersionResult = {
  status: 'ok' | 'pending' | 'unknown';
  expected?: string;
  applied?: string;
  /** SANITIZED, safe to return on a public probe. */
  detail?: string;
};

/** Schema does not move under a running process; 60s is generous. */
const SCHEMA_CHECK_CACHE_MS = 60_000;

let expectedCache: string | null | undefined;
let lastResult: SchemaVersionResult | null = null;
let lastCheckedAt = 0;

/**
 * Newest forward migration file on disk. Cached; `null` when the directory is
 * unreadable (e.g. a container that ships `dist/` without `migrations/`), in
 * which case the check reports `unknown` rather than inventing an answer.
 */
export function expectedSchemaVersion(): string | null {
  if (expectedCache !== undefined) return expectedCache;
  try {
    const files = readdirSync(join(process.cwd(), 'migrations'))
      .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
      .sort();
    expectedCache = files.length > 0 ? files[files.length - 1]! : null;
  } catch {
    expectedCache = null;
  }
  return expectedCache;
}

export async function checkSchemaVersion(): Promise<SchemaVersionResult> {
  const now = Date.now();
  if (lastResult && now - lastCheckedAt < SCHEMA_CHECK_CACHE_MS) return lastResult;

  const expected = expectedSchemaVersion();
  if (!expected) {
    lastResult = { status: 'unknown', detail: 'migrations directory not readable' };
    lastCheckedAt = now;
    return lastResult;
  }

  try {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
    );
    // drizzle's node-postgres driver returns a pg QueryResult; be tolerant of
    // the array-like shape used by other drivers so this never throws.
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: { id: string }[] }).rows) ?? [];
    const applied = list[0]?.id;
    if (!applied) {
      lastResult = {
        status: 'pending',
        expected,
        detail: 'schema_migrations is empty — run npm run db:migrate',
      };
    } else if (applied < expected) {
      lastResult = {
        status: 'pending',
        expected,
        applied,
        detail: 'applied migration is older than the newest file on disk',
      };
    } else {
      // `applied > expected` happens on a ROLLBACK deploy (new schema, older
      // code). Forward-compatible migrations are the norm here, so this is
      // `ok` with the versions reported rather than a hard drain.
      lastResult = { status: 'ok', expected, applied };
    }
  } catch (err) {
    // Raw driver text never leaves this module (issue #512: "Raw errors,
    // secrets e paths internos não aparecem em health público").
    logger.warn({ err: (err as Error).message }, 'lifecycle.schema_version_query_failed');
    lastResult = { status: 'unknown', expected, detail: 'schema version query failed' };
  }
  lastCheckedAt = now;
  return lastResult;
}

/** Test seam — clears both caches. */
export function _resetSchemaVersionCacheForTests(): void {
  expectedCache = undefined;
  lastResult = null;
  lastCheckedAt = 0;
}
