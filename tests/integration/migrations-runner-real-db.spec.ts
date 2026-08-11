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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations, repairMigration, repairAppliedRefusal } from '@/migrations/runner.js';
import { main as migrateCli } from '../../scripts/migrate.js';
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
    await write('003_later.sql', 'CREATE TABLE t_later (id TEXT);\n');
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

    // #541 finding 1: `status` is the ledger as it stands NOW, not the snapshot
    // taken before the loop. It must agree with the rows just read back.
    const status = result.status!;
    const state = (id: string) => status.entries.find((e) => e.id === id)!.state;
    expect(state('001_plain.sql')).toBe('applied');
    expect(state('002_bad.sql')).toBe('failed');
    expect(state('003_later.sql')).toBe('pending');
    expect(status.counts).toMatchObject({ total: 3, applied: 1, failed: 1, pending: 1, dirty: 0 });
    expect(status.applied_head).toBe('001_plain.sql');
    expect(state(result.failure!.id)).toBe(result.failure!.ledger_status);
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

    // #541 finding 1: the report returned WITH the failure already says dirty.
    // Before the fix it still said `pending` for this id — while `failure`
    // beside it said `dirty` — and listed 001 (applied moments earlier in this
    // very run) as pending too.
    const status = failed.status!;
    const entry = (id: string) => status.entries.find((e) => e.id === id)!;
    expect(entry('001_plain.sql').state).toBe('applied');
    expect(entry('002_idx.sql').state).toBe('dirty');
    expect(entry('002_idx.sql').blocking).toBe(true);
    expect(entry('003_plain.sql').state).toBe('pending');
    expect(status.counts).toMatchObject({ total: 3, applied: 1, dirty: 1, pending: 1, failed: 0 });
    expect(status.applied_head).toBe('001_plain.sql');
    expect(entry(failed.failure!.id).state).toBe(failed.failure!.ledger_status);

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

  /**
   * #541 finding 2 — `BEGIN;` is not proof that a `self` migration is atomic.
   *
   * This is the case a fake cannot settle, because the question is what REAL
   * Postgres does: after the file's own `COMMIT`, the DDL is durable, so the
   * `ROLLBACK` the runner issues in its catch block undoes nothing and the
   * migration would be filed as `failed` — the auto-retried status — on top of
   * a half-applied schema. The first assertion proves the hazard against the
   * server; the second proves the runner now refuses the file before it runs.
   */
  it('proves the hazard: after a file COMMITs, a later failure is NOT rolled back', async () => {
    const client = await pool.connect();
    try {
      await expect(
        client.query('BEGIN;\nCREATE TABLE t_leaky (id TEXT);\nCOMMIT;\nSELECT nonexistent_fn();\n'),
      ).rejects.toThrow();
      // Exactly what the old catch block did before recording `failed`.
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    const t = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `${SCHEMA}.t_leaky`,
    ]);
    // Durable. `failed` (retryable) would have been a lie about this schema.
    expect(t.rows[0]).toEqual({ present: true });
  }, 30_000);

  it('refuses a `self` migration whose SQL is not one complete envelope', async () => {
    await write('001_plain.sql', PLAIN);
    await write(
      '002_leaky.sql',
      'BEGIN;\nCREATE TABLE t_leaky (id TEXT);\nCOMMIT;\nSELECT nonexistent_fn();\n',
    );

    const result = await runMigrations(deps());
    expect(result.outcome).toBe('blocked');
    const blocker = result.blockers.find((b) => b.id === '002_leaky.sql')!;
    expect(blocker.kind).toBe('artifact_integrity');
    expect(blocker.detail).toContain('statement_after_commit');

    // Refused before ANY DDL: not even the well-formed 001 was applied.
    const created = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `${SCHEMA}.t_leaky`,
    ]);
    expect(created.rows[0]).toEqual({ present: false });
    const plain = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `${SCHEMA}.t_plain`,
    ]);
    expect(plain.rows[0]).toEqual({ present: false });
    const rows = await pool.query('SELECT id FROM schema_migrations');
    expect(rows.rows).toEqual([]);
  }, 30_000);

  it('applies a well-formed self-transactional file and records it verified', async () => {
    await write('001_self.sql', SELF_TX);
    const result = await runMigrations(deps());
    expect(result.outcome).toBe('applied');
    expect(result.blockers).toEqual([]);
    const row = await pool.query<{ status: string; checksum_source: string }>(
      'SELECT status, checksum_source FROM schema_migrations WHERE id = $1',
      ['001_self.sql'],
    );
    expect(row.rows[0]).toEqual({ status: 'applied', checksum_source: 'computed' });
  }, 30_000);

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

  /**
   * The medium finding from the #541 review, against the REAL ledger.
   *
   * `repairEntry` writes `checksum_sha256 = COALESCE($2, checksum_sha256)`, so
   * with no packaged file the UPDATE still flipped `status` to `applied` and
   * stamped `checksum_source = 'backfilled'` over a NULL checksum, and the CLI
   * printed `repaired …`. The very next `status`/`up` blocked again on
   * `missing_file` — "repaired" without readiness having been repaired.
   */
  it('refuses `repair --as applied` for a migration this build does not package, leaving the row untouched', async () => {
    await write('001_plain.sql', PLAIN);
    await runMigrations(deps());
    // A row the current artifact knows nothing about — the shape a rollback,
    // a reverted branch or a downgraded image really produces.
    await pool.query(
      "INSERT INTO schema_migrations (id, status, applied_at) VALUES ($1, 'dirty', NULL)",
      ['099_ghost.sql'],
    );
    expect((await runMigrations(deps())).outcome).toBe('blocked');

    const refused = await repairMigration(deps(), {
      id: '099_ghost.sql',
      outcome: 'applied',
      reason: 'schema conferido a mao durante o incidente',
    });
    expect(refused).toEqual({
      ok: false,
      reason: repairAppliedRefusal('099_ghost.sql', 'artifact_missing'),
    });

    // The real row is byte-for-byte what it was: nothing was certified.
    const row = await pool.query<{
      status: string;
      checksum_sha256: string | null;
      checksum_source: string | null;
      repaired_at: Date | null;
      repair_reason: string | null;
    }>(
      'SELECT status, checksum_sha256, checksum_source, repaired_at, repair_reason FROM schema_migrations WHERE id = $1',
      ['099_ghost.sql'],
    );
    expect(row.rows[0]).toEqual({
      status: 'dirty',
      checksum_sha256: null,
      checksum_source: null,
      repaired_at: null,
      repair_reason: null,
    });

    // And readiness agrees with the refusal instead of contradicting it.
    const readiness = await getSchemaReadiness({ pool, migrationsDir: dir });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.kind)).toContain('missing_file');

    // The remediation the refusal names DOES work, on the same real row.
    const repaired = await repairMigration(deps(), {
      id: '099_ghost.sql',
      outcome: 'pending',
      reason: 'linha orfa de um build anterior; efeitos ja desfeitos',
    });
    expect(repaired.ok).toBe(true);
    const gone = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [
      '099_ghost.sql',
    ]);
    expect(gone.rows).toHaveLength(0);
    expect((await getSchemaReadiness({ pool, migrationsDir: dir })).ready).toBe(true);
  }, 60_000);

  it('the CLI prints the refusal and exits 1, without connecting to the database', async () => {
    // Exit behaviour is the operator-visible half of the fix: `repair refused:`
    // on stderr and a non-zero code, so a script or an init container cannot
    // read the lie as success. The refusal happens before the lock, so the
    // pool is never even connected.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    try {
      const code = await migrateCli([
        'repair',
        '--id',
        '999_not_in_this_build.sql',
        '--as',
        'applied',
        '--reason',
        'schema conferido a mao',
      ]);
      expect(code).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const printed = errors.join('\n');
    expect(printed).toContain('repair refused:');
    expect(printed).toContain(
      repairAppliedRefusal('999_not_in_this_build.sql', 'artifact_missing'),
    );
    expect(printed).toContain('--as pending');
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
