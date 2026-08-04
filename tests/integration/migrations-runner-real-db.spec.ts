/**
 * Issue #516 — the migration runner against REAL Postgres.
 *
 * The unit suite proves the ORDER OF OPERATIONS with a behavioural fake. This
 * spec proves the parts a fake cannot: that the ledger DDL actually applies,
 * that `pg_advisory_lock` really serialises two migrators, that a `running` row
 * really survives a killed run, and that the `ON CONFLICT … WHERE status <>
 * 'applied'` guard behaves as written.
 *
 * ### Isolation
 *
 * It does NOT run the repo's 118 real migrations. It builds a throwaway
 * migrations directory with a handful of tiny files and points the runner at
 * it, inside a DEDICATED Postgres schema (`search_path`), so:
 *   - the real `schema_migrations` of the CI database is never touched,
 *   - the suite is fast and its assertions are about the runner, not about the
 *     accumulated history of the product.
 *
 * The full real chain is still exercised in CI by the `Apply migrations` step
 * (`npm run db:migrate`) that runs before this suite.
 *
 * ### Runtime requirement
 *
 * Needs `TEST_DB_URL` pointing at a reachable Postgres — the CI `integration`
 * job provides it from a service container (.github/workflows/ci.yml). The
 * suite SKIPS cleanly when it is unset, so a sandbox with no database stays
 * green.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations, repairMigration } from '@/migrations/runner.js';
import { getMigrationStatus, getSchemaReadiness } from '@/migrations/readiness.js';
import { migrationChecksum } from '@/migrations/checksum.js';

/**
 * Gated on TEST_DB_URL ONLY, matching every other real-DB spec here (e.g.
 * `agent-tool-grants-leak.spec.ts`). `DATABASE_URL` is NOT usable as a fallback:
 * `tests/setup.ts` sets it unconditionally to a localhost DSN, so falling back
 * to it would make this suite attempt a connection — and fail — on every
 * unit-only lane. CI's `integration` job sets `TEST_DB_URL` from its service
 * container (.github/workflows/ci.yml).
 */
const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

/** Unique schema per run so parallel workers cannot collide. */
const SCHEMA = `maia_mig_${Math.random().toString(36).slice(2, 10)}`;

const PLAIN = 'CREATE TABLE t_plain (id TEXT PRIMARY KEY);\n';
const SELF_TX = 'BEGIN;\nCREATE TABLE t_self (id TEXT PRIMARY KEY);\nCOMMIT;\n';
const NO_TX =
  '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_plain_idx ON t_plain (id);\n';

let pool: pg.Pool;
let admin: pg.Pool;
let dir: string;

async function write(name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
  await writeFile(join(dir, name.replace(/\.sql$/, '_down.sql')), '-- down\nSELECT 1;\n', 'utf8');
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    pool,
    migrationsDir: dir,
    appVersion: 'test',
    ...overrides,
  } as unknown as Parameters<typeof runMigrations>[0];
}

d('migration runner — real Postgres (#516)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    // Every pooled connection lands in the throwaway schema, so the unqualified
    // `schema_migrations` the runner uses resolves there and nowhere else.
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 6,
      options: `-c search_path=${SCHEMA}`,
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maia-mig-real-'));
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('bootstraps ledger v2 and applies the chain, recording checksums', async () => {
    await write('001_plain.sql', PLAIN);
    await write('002_self.sql', SELF_TX);
    await write('003_idx.sql', NO_TX);

    const result = await runMigrations(deps());
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(['001_plain.sql', '002_self.sql', '003_idx.sql']);

    const rows = await pool.query<{
      id: string;
      checksum_sha256: string;
      checksum_source: string;
      status: string;
      execution_ms: number;
      runner_version: string;
    }>('SELECT id, checksum_sha256, checksum_source, status, execution_ms, runner_version FROM schema_migrations ORDER BY id');
    expect(rows.rows.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(rows.rows[0]!.checksum_sha256).toBe(migrationChecksum(PLAIN));
    expect(rows.rows[0]!.checksum_source).toBe('computed');
    expect(rows.rows[0]!.runner_version).toBe('2.0.0');
    expect(rows.rows[0]!.execution_ms).toBeGreaterThanOrEqual(0);

    // The CONCURRENTLY index really was created outside a transaction.
    const idx = await pool.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', ['t_plain_idx']);
    expect(idx.rows).toHaveLength(1);

    const readiness = await getSchemaReadiness({ pool, migrationsDir: dir });
    expect(readiness.ready).toBe(true);
    expect(readiness.applied_head).toBe('003_idx.sql');
  }, 60_000);

  it('is idempotent: a second run applies nothing', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    const again = await runMigrations(deps());
    expect(again.outcome).toBe('up_to_date');
    expect(again.applied).toEqual([]);
  }, 30_000);

  it('serialises two concurrent migrators — the file is applied exactly once', async () => {
    await write('001_plain.sql', PLAIN);
    const [a, b] = await Promise.all([runMigrations(deps()), runMigrations(deps())]);
    const applied = [...a.applied, ...b.applied];
    // Exactly one of them did the work; the other waited and found nothing.
    expect(applied).toEqual(['001_plain.sql']);
    expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'up_to_date']);
    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations');
    expect(count.rows[0]!.n).toBe('1');
  }, 60_000);

  it('the second migrator exits cleanly and observably when the wait elapses', async () => {
    await write('001_plain.sql', PLAIN);
    // Hold the lock from an independent session for the duration.
    const holder = await pool.connect();
    await holder.query(
      "SELECT pg_advisory_lock(hashtextextended('maia_schema_migrations', '51605160'))",
    );
    try {
      const result = await runMigrations(deps(), { waitMs: 300, pollMs: 100 });
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('lock_unavailable');
      const exists = await pool.query(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`${SCHEMA}.schema_migrations`],
      );
      // It refused BEFORE creating anything.
      expect(exists.rows[0]).toEqual({ present: false });
    } finally {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtextextended('maia_schema_migrations', '51605160'))",
      );
      holder.release();
    }
  }, 30_000);

  it('a transactional failure leaves NO partial change and a retryable row', async () => {
    await write('001_plain.sql', PLAIN);
    await write('002_bad.sql', 'CREATE TABLE t_ok (id TEXT);\nSELECT nonexistent_fn();\n');
    const result = await runMigrations(deps());
    expect(result.outcome).toBe('failed');
    expect(result.failure?.ledger_status).toBe('failed');

    // The whole file rolled back — t_ok must not exist.
    const t = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${SCHEMA}.t_ok`]);
    expect(t.rows[0]).toEqual({ present: false });

    const row = await pool.query<{ status: string; applied_at: Date | null }>(
      'SELECT status, applied_at FROM schema_migrations WHERE id = $1',
      ['002_bad.sql'],
    );
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.applied_at).toBeNull();
  }, 30_000);

  it('a no-transaction failure leaves a DIRTY row that blocks every later run', async () => {
    await write('001_plain.sql', PLAIN);
    // CONCURRENTLY against a missing column fails midway through the file.
    await write(
      '002_idx.sql',
      '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ok_idx ON t_plain (id);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS bad_idx ON t_plain (missing_column);\n',
    );
    await write('003_plain.sql', 'CREATE TABLE t_later (id TEXT);\n');

    const failed = await runMigrations(deps());
    expect(failed.failure?.ledger_status).toBe('dirty');

    const row = await pool.query<{ status: string; error_class: string }>(
      'SELECT status, error_class FROM schema_migrations WHERE id = $1',
      ['002_idx.sql'],
    );
    expect(row.rows[0]!.status).toBe('dirty');
    expect(row.rows[0]!.error_class).toBeTruthy();

    // The partial effect is real — the first index exists — which is exactly
    // why the state is dirty and not simply "failed".
    const partial = await pool.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', ['ok_idx']);
    expect(partial.rows).toHaveLength(1);

    // Dirty blocks: 003 is never attempted, on this run or the next.
    const blocked = await runMigrations(deps());
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.blockers.map((b) => b.kind)).toContain('dirty_migration');
    const later = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${SCHEMA}.t_later`,
    ]);
    expect(later.rows[0]).toEqual({ present: false });

    const readiness = await getSchemaReadiness({ pool, migrationsDir: dir });
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('blocked');
  }, 60_000);

  it('a crashed run (`running` row) is promoted to dirty on the next pass', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    // Simulate a process killed between "started" and "applied".
    await pool.query(
      "INSERT INTO schema_migrations (id, status, started_at, applied_at) VALUES ($1, 'running', now(), NULL)",
      ['002_crashed.sql'],
    );
    await write('002_crashed.sql', 'CREATE TABLE t_crash (id TEXT);\n');

    const result = await runMigrations(deps());
    expect(result.orphaned).toEqual(['002_crashed.sql']);
    expect(result.outcome).toBe('blocked');
    const row = await pool.query<{ status: string; error_class: string }>(
      'SELECT status, error_class FROM schema_migrations WHERE id = $1',
      ['002_crashed.sql'],
    );
    expect(row.rows[0]!.status).toBe('dirty');
    expect(row.rows[0]!.error_class).toBe('orphaned_running');
  }, 30_000);

  it('repair --as pending lets a dirty migration re-run from scratch', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    await pool.query(
      "INSERT INTO schema_migrations (id, status, applied_at) VALUES ($1, 'dirty', NULL)",
      ['002_next.sql'],
    );
    await write('002_next.sql', 'CREATE TABLE t_next (id TEXT);\n');

    expect((await runMigrations(deps())).outcome).toBe('blocked');

    const repaired = await repairMigration(deps(), {
      id: '002_next.sql',
      outcome: 'pending',
      reason: 'verified nothing was applied; safe to retry',
    });
    expect(repaired.ok).toBe(true);

    const rerun = await runMigrations(deps());
    expect(rerun.applied).toEqual(['002_next.sql']);
    const t = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${SCHEMA}.t_next`]);
    expect(t.rows[0]).toEqual({ present: true });
  }, 30_000);

  it('repair --as applied closes a dirty row and persists the reason', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    await pool.query("UPDATE schema_migrations SET status = 'dirty' WHERE id = $1", ['001_plain.sql']);

    const repaired = await repairMigration(deps(), {
      id: '001_plain.sql',
      outcome: 'applied',
      reason: 'schema verified by hand during the #516 drill',
    });
    expect(repaired.ok).toBe(true);

    const row = await pool.query<{ status: string; repair_reason: string; repaired_at: Date; checksum_source: string }>(
      'SELECT status, repair_reason, repaired_at, checksum_source FROM schema_migrations WHERE id = $1',
      ['001_plain.sql'],
    );
    expect(row.rows[0]!.status).toBe('applied');
    expect(row.rows[0]!.repair_reason).toContain('#516 drill');
    expect(row.rows[0]!.repaired_at).not.toBeNull();
    expect(row.rows[0]!.checksum_source).toBe('backfilled');
  }, 30_000);

  it('adopts checksums from a v1 ledger, then blocks on a later edit', async () => {
    await write('001_plain.sql', PLAIN);
    // Build the pre-#516 ledger shape by hand and record 001 the old way.
    await pool.query(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', ['001_plain.sql']);
    await pool.query(PLAIN);

    // A read-only probe refuses to guess — and refuses to backfill.
    const before = await getMigrationStatus({ pool, migrationsDir: dir });
    expect(before.ledger_version).toBe(1);
    expect(before.entries[0]!.state).toBe('checksum_unknown');

    const adopted = await runMigrations(deps());
    expect(adopted.backfilled).toEqual(['001_plain.sql']);
    const row = await pool.query<{ checksum_sha256: string; checksum_source: string }>(
      'SELECT checksum_sha256, checksum_source FROM schema_migrations WHERE id = $1',
      ['001_plain.sql'],
    );
    expect(row.rows[0]!.checksum_sha256).toBe(migrationChecksum(PLAIN));
    expect(row.rows[0]!.checksum_source).toBe('backfilled');

    // Now edit the applied migration — the whole point of the feature.
    await write('001_plain.sql', `${PLAIN}-- an edit after the fact\n`);
    const blocked = await runMigrations(deps());
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
    const readiness = await getSchemaReadiness({ pool, migrationsDir: dir });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
  }, 30_000);

  it('the ledger v2 CHECK constraints reject unknown states', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    await expect(
      pool.query("UPDATE schema_migrations SET status = 'whatever' WHERE id = $1", ['001_plain.sql']),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE schema_migrations SET checksum_source = 'guessed' WHERE id = $1", [
        '001_plain.sql',
      ]),
    ).rejects.toThrow();
  }, 30_000);

  it('readiness on a database with no ledger at all is unknown, never ready', async () => {
    await write('001_plain.sql', PLAIN);
    const readiness = await getSchemaReadiness({ pool, migrationsDir: dir });
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe('unknown');
    expect(readiness.blockers[0]!.kind).toBe('ledger_missing');
    // Still read-only: it did not create the ledger it just complained about.
    const exists = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${SCHEMA}.schema_migrations`,
    ]);
    expect(exists.rows[0]).toEqual({ present: false });
  }, 30_000);
});
