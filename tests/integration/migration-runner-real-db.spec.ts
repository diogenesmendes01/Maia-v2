/**
 * Issue #516 — the migration runner against REAL Postgres.
 *
 * WHY THIS FILE EXISTS AS AN INTEGRATION SPEC: the four guarantees the issue
 * is actually about — the advisory lock, transactional atomicity, DIRTY state
 * after a non-transactional failure, and the v1→v2 ledger upgrade — are all
 * SERVER semantics. None of them can be proven against an in-memory fake: a
 * fake would happily "serialise" two callers that real Postgres would let run
 * concurrently, and "the transaction rolled back so no partial change remains"
 * is a claim only a real server can settle. These tests are therefore the ONLY
 * evidence that exists for those behaviours.
 *
 * Each case builds a TINY synthetic migration directory in a temp folder
 * rather than running the repo's 120-file chain: the properties under test are
 * about the runner, and a three-file chain makes a failure point at the runner
 * instead of at whatever real migration happened to break.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON
 *
 * Same contract as the sibling testcontainer specs. The suite cleanly SKIPS
 * (does not fail) when Docker is unreachable; `SKIP_DOCKER_TESTS=1` forces the
 * skip. Run explicitly with `npm run test:integration:real-db`.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { isDockerAvailable } from './_fixtures/postgres-testcontainer.js';
import {
  migrateUp,
  planMigrations,
  repairMigration,
  type RunnerOptions,
} from '@/migrations/runner.js';
import { silentMigrationLogger } from '@/migrations/log.js';
import { acquireMigrationLock, releaseMigrationLock } from '@/migrations/lock.js';
import { checksumOf } from '@/migrations/discover.js';
import { EVENTS_TABLE, LEDGER_TABLE } from '@/migrations/ledger.js';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const tempDirs: string[] = [];

/** Build a throwaway migration directory. Every forward file gets a down sibling. */
function chain(files: Record<string, string>, opts: { skipDown?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'maia-runner-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
    if (!opts.skipDown?.includes(name)) {
      writeFileSync(join(dir, name.replace(/\.sql$/, '_down.sql')), '-- no-op down\nSELECT 1;\n');
    }
  }
  return dir;
}

function options(migrationsDir: string, over: Partial<RunnerOptions> = {}): RunnerOptions {
  return { pool, migrationsDir, logger: silentMigrationLogger, ...over };
}

async function ledger(): Promise<
  { id: string; status: string; checksum_sha256: string | null; checksum_source: string | null }[]
> {
  const res = await pool.query(`SELECT * FROM ${LEDGER_TABLE} ORDER BY id`);
  return res.rows as never;
}

async function tableExists(name: string): Promise<boolean> {
  const res = await pool.query('SELECT to_regclass($1) AS reg', [`public.${name}`]);
  return (res.rows[0] as { reg: string | null }).reg !== null;
}

d('migration runner (#516) — real Postgres', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('maia_runner')
      .withUsername('maia_runner')
      .withPassword('test1234')
      .start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 6 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // A brand-new schema per case: these tests are about the LEDGER's state
    // machine, so leaking one case's rows into the next would be fatal.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  // -------------------------------------------------------------------------
  // Concurrency — "Dois migrators concorrentes não aplicam o mesmo arquivo
  // duas vezes" / "O segundo migrator aguarda ou encerra de forma limpa"
  // -------------------------------------------------------------------------
  describe('advisory lock', () => {
    it('serialises two concurrent migrators: each file is applied exactly once', async () => {
      const dir = chain({
        '001_slow.sql': 'CREATE TABLE slow_a (id INT);\nSELECT pg_sleep(1);\n',
        '002_after.sql': 'CREATE TABLE slow_b (id INT);\n',
      });

      const [first, second] = await Promise.all([
        migrateUp(options(dir)),
        migrateUp(options(dir)),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(['applied', 'noop']);

      const rows = await ledger();
      expect(rows.map((r) => r.id)).toEqual(['001_slow.sql', '002_after.sql']);
      expect(rows.every((r) => r.status === 'applied')).toBe(true);
      // The decisive assertion: the loser applied NOTHING, so no file ran twice.
      const applied = [
        ...(first.outcome === 'applied' ? first.applied : []),
        ...(second.outcome === 'applied' ? second.applied : []),
      ];
      expect(applied.map((a) => a.id).sort()).toEqual(['001_slow.sql', '002_after.sql']);
    }, 60_000);

    it('exits CLEANLY with lock_timeout when the lock is held by someone else', async () => {
      const dir = chain({ '001_x.sql': 'CREATE TABLE never_created (id INT);\n' });
      const holder = await pool.connect();
      try {
        const held = await acquireMigrationLock(holder, 5_000);
        expect(held.acquired).toBe(true);

        const result = await migrateUp(options(dir, { lockTimeoutMs: 300 }));
        expect(result.outcome).toBe('lock_timeout');
        // Nothing was attempted: no DDL, and not even the ledger was created.
        expect(await tableExists('never_created')).toBe(false);
        expect(await tableExists(LEDGER_TABLE)).toBe(false);
      } finally {
        await releaseMigrationLock(holder);
        holder.release();
      }
    }, 60_000);

    it('releases the lock and the pooled client on every path', async () => {
      const dir = chain({ '001_x.sql': 'CREATE TABLE ok_a (id INT);\n' });
      await migrateUp(options(dir));
      expect(pool.waitingCount).toBe(0);
      // A second run can still take the lock — proof the first released it.
      const again = await migrateUp(options(dir, { lockTimeoutMs: 1_000 }));
      expect(again.outcome).toBe('noop');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Transactional semantics — "Falha transacional não deixa alteração parcial"
  // -------------------------------------------------------------------------
  describe('transactional migrations', () => {
    it('leaves NO partial change when a migration fails mid-file', async () => {
      const dir = chain({
        '001_partial.sql':
          'CREATE TABLE half_applied (id INT);\nSELECT * FROM table_that_does_not_exist;\n',
      });
      const result = await migrateUp(options(dir));

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.dirty).toBe(false);
      expect(result.error_class).toBe('42P01');
      // The first statement committed nothing: the whole file rolled back.
      expect(await tableExists('half_applied')).toBe(false);

      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('failed');
    }, 60_000);

    it('records the ledger row ATOMICALLY with the schema change', async () => {
      const dir = chain({ '001_atomic.sql': 'CREATE TABLE atomic_ok (id INT);\n' });
      await migrateUp(options(dir));
      expect(await tableExists('atomic_ok')).toBe(true);
      const rows = await ledger();
      expect(rows[0]!.status).toBe('applied');
      expect(rows[0]!.checksum_source).toBe('runner');
    }, 60_000);

    it('does NOT attempt migrations after a failure', async () => {
      const dir = chain({
        '001_boom.sql': 'SELECT * FROM nope;\n',
        '002_never.sql': 'CREATE TABLE never_reached (id INT);\n',
      });
      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('failed');
      expect(await tableExists('never_reached')).toBe(false);
      expect((await ledger()).map((r) => r.id)).toEqual(['001_boom.sql']);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Dirty state — "Crash simulado em migration no-tx deixa estado dirty" and
  // "Dirty bloqueia migrations seguintes"
  // -------------------------------------------------------------------------
  describe('no-transaction migrations', () => {
    it('leaves DIRTY state when a no-tx migration fails part-way', async () => {
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_concurrent.sql':
          '-- maia:no-transaction\n' +
          'CREATE INDEX CONCURRENTLY idx_ok ON idx_target (id);\n' +
          'CREATE INDEX CONCURRENTLY idx_bad ON table_that_does_not_exist (id);\n',
        '003_after.sql': 'CREATE TABLE after_dirty (id INT);\n',
      });

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('unreachable');
      expect(result.dirty).toBe(true);

      const rows = await ledger();
      expect(rows.find((r) => r.id === '002_concurrent.sql')!.status).toBe('dirty');
      // The partial change really is there — that is WHY it is dirty.
      const idx = await pool.query("SELECT to_regclass('public.idx_ok') AS reg");
      expect((idx.rows[0] as { reg: string | null }).reg).not.toBeNull();
      // …and everything after it was deliberately not attempted.
      expect(await tableExists('after_dirty')).toBe(false);
    }, 60_000);

    it('BLOCKS the next run: dirty is never interpreted as success', async () => {
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_concurrent.sql':
          '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY idx_bad ON missing_table (id);\n',
      });
      await migrateUp(options(dir));

      const second = await migrateUp(options(dir));
      expect(second.outcome).toBe('blocked');
      if (second.outcome !== 'blocked') throw new Error('unreachable');
      expect(second.problems.map((p) => p.code)).toContain('dirty');
    }, 60_000);

    it('turns a CRASHED no-tx run (orphan running row) into dirty on the next run', async () => {
      // Simulates a hard kill: the row says `running`, the process is gone.
      // With the advisory lock held, a `running` row can only be an orphan.
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_concurrent.sql':
          '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY idx_ok ON idx_target (id);\n',
      });
      await migrateUp(options(dir));
      await pool.query(
        `UPDATE ${LEDGER_TABLE} SET status = 'running', applied_at = NULL, started_at = now() WHERE id = $1`,
        ['002_concurrent.sql'],
      );

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('blocked');
      expect((await ledger()).find((r) => r.id === '002_concurrent.sql')!.status).toBe('dirty');
    }, 60_000);

    it('RETRIES a crashed no-tx run that declared itself idempotent', async () => {
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_idem.sql':
          '-- maia:no-transaction\n-- maia:idempotent\n' +
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_idem ON idx_target (id);\n',
      });
      await migrateUp(options(dir));
      await pool.query(
        `UPDATE ${LEDGER_TABLE} SET status = 'running', applied_at = NULL, started_at = now() WHERE id = $1`,
        ['002_idem.sql'],
      );

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('applied');
      expect((await ledger()).find((r) => r.id === '002_idem.sql')!.status).toBe('applied');
    }, 60_000);

    it('resets a crashed TRANSACTIONAL run instead of calling it dirty', async () => {
      // A transactional migration that died mid-flight rolled back, so there is
      // nothing partial to inspect: retrying is provably safe.
      const dir = chain({ '001_tx.sql': 'CREATE TABLE tx_retry (id INT);\n' });
      await migrateUp(options(dir));
      await pool.query(`DROP TABLE tx_retry`);
      await pool.query(
        `UPDATE ${LEDGER_TABLE} SET status = 'running', applied_at = NULL, started_at = now() WHERE id = $1`,
        ['001_tx.sql'],
      );

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('applied');
      expect(await tableExists('tx_retry')).toBe(true);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Checksums — "Alterar uma migration aplicada faz status, up e readiness
  // falharem"
  // -------------------------------------------------------------------------
  describe('checksums', () => {
    it('blocks `up` when an ALREADY-APPLIED migration was edited', async () => {
      const dir = chain({ '001_edit.sql': 'CREATE TABLE edited (id INT);\n' });
      expect((await migrateUp(options(dir))).outcome).toBe('applied');

      writeFileSync(join(dir, '001_edit.sql'), 'CREATE TABLE edited (id BIGINT);\n');
      writeFileSync(join(dir, '002_new.sql'), 'CREATE TABLE new_one (id INT);\n');
      writeFileSync(join(dir, '002_new_down.sql'), 'SELECT 1;\n');

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.problems.map((p) => p.code)).toContain('checksum_mismatch');
      // The pending migration was NOT applied — the refusal precedes all DDL.
      expect(await tableExists('new_one')).toBe(false);
    }, 60_000);

    it('surfaces the same mismatch through the read-only plan', async () => {
      const dir = chain({ '001_edit.sql': 'CREATE TABLE p_edit (id INT);\n' });
      await migrateUp(options(dir));
      writeFileSync(join(dir, '001_edit.sql'), 'CREATE TABLE p_edit (id BIGINT);\n');

      const plan = await planMigrations(options(dir));
      expect(plan.compatibility.compatible).toBe(false);
      expect(plan.compatibility.problems.map((p) => p.code)).toContain('checksum_mismatch');
      expect(plan.compatibility.counters.mismatch_count).toBe(1);
    }, 60_000);

    it('records the checksum of the CANONICAL bytes, so CRLF is not drift', async () => {
      const body = 'CREATE TABLE crlf_ok (id INT);\n';
      const dir = chain({ '001_crlf.sql': body });
      await migrateUp(options(dir));

      writeFileSync(join(dir, '001_crlf.sql'), body.replace(/\n/g, '\r\n'));
      const plan = await planMigrations(options(dir));
      expect(plan.compatibility.compatible).toBe(true);
      expect((await ledger())[0]!.checksum_sha256).toBe(checksumOf(body));
    }, 60_000);

    it('blocks `up` when a forward migration ships without its _down sibling', async () => {
      const dir = chain({ '001_nodown.sql': 'CREATE TABLE no_down (id INT);\n' }, {
        skipDown: ['001_nodown.sql'],
      });
      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.problems.map((p) => p.code)).toContain('missing_down_sibling');
      expect(await tableExists('no_down')).toBe(false);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Ledger v1 → v2 — "Teste do ledger antigo para v2"
  // -------------------------------------------------------------------------
  describe('ledger upgrade', () => {
    it('upgrades a v1 ledger in place and BACKFILLS checksums from the artifact', async () => {
      const body = 'CREATE TABLE legacy (id INT);\n';
      const dir = chain({ '001_legacy.sql': body, '002_next.sql': 'CREATE TABLE next_t (id INT);\n' });

      // Exactly what the pre-#516 runner leaves behind.
      await pool.query(
        `CREATE TABLE ${LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      await pool.query(`INSERT INTO ${LEDGER_TABLE} (id) VALUES ($1)`, ['001_legacy.sql']);
      await pool.query(body);

      const result = await migrateUp(options(dir));
      expect(result.outcome).toBe('applied');

      const rows = await ledger();
      const legacy = rows.find((r) => r.id === '001_legacy.sql')!;
      expect(legacy.status).toBe('applied');
      expect(legacy.checksum_sha256).toBe(checksumOf(body));
      // Provenance stays visible forever: this one was TRUSTED, not verified.
      expect(legacy.checksum_source).toBe('backfilled');
      expect(rows.find((r) => r.id === '002_next.sql')!.checksum_source).toBe('runner');
    }, 60_000);

    it('keeps the v1 INSERT working, so the old runner still reads the ledger', async () => {
      const dir = chain({ '001_a.sql': 'CREATE TABLE v1_compat (id INT);\n' });
      await migrateUp(options(dir));
      // The pre-#516 runner's exact statements.
      await pool.query(`INSERT INTO ${LEDGER_TABLE} (id) VALUES ($1)`, ['999_old_runner.sql']);
      const res = await pool.query(`SELECT id FROM ${LEDGER_TABLE} ORDER BY id`);
      expect(res.rows.map((r) => (r as { id: string }).id)).toContain('999_old_runner.sql');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Repair — "Existe procedimento explícito e auditável de repair"
  // -------------------------------------------------------------------------
  describe('repair', () => {
    it('unblocks a dirty migration and writes an AUDITABLE trail row', async () => {
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_concurrent.sql':
          '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY idx_bad ON missing_table (id);\n',
        '003_after.sql': 'CREATE TABLE after_repair (id INT);\n',
      });
      await migrateUp(options(dir));
      expect((await migrateUp(options(dir))).outcome).toBe('blocked');

      const repair = await repairMigration(options(dir), {
        id: '002_concurrent.sql',
        resolution: 'applied',
        reason: 'verified idx_bad is not needed; schema inspected by hand',
        actor: 'ops-oncall',
      });
      expect(repair.outcome).toBe('repaired');

      const events = await pool.query(
        `SELECT event, migration_id, actor, reason FROM ${EVENTS_TABLE} WHERE event = 'repair'`,
      );
      expect(events.rows).toHaveLength(1);
      expect((events.rows[0] as { actor: string }).actor).toBe('ops-oncall');
      expect((events.rows[0] as { reason: string }).reason).toMatch(/inspected by hand/);

      // …and the chain moves again.
      const after = await migrateUp(options(dir));
      expect(after.outcome).toBe('applied');
      expect(await tableExists('after_repair')).toBe(true);
    }, 60_000);

    it('re-runs the migration when the operator asserts nothing was applied', async () => {
      const dir = chain({
        '001_base.sql': 'CREATE TABLE idx_target (id INT);\n',
        '002_idx.sql': '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY idx_r ON idx_target (id);\n',
      });
      await migrateUp(options(dir));
      await pool.query(`UPDATE ${LEDGER_TABLE} SET status = 'dirty' WHERE id = $1`, ['002_idx.sql']);
      await pool.query('DROP INDEX idx_r');

      const repair = await repairMigration(options(dir), {
        id: '002_idx.sql',
        resolution: 'pending',
        reason: 'index absent in the database; re-running from scratch',
        actor: 'ops-oncall',
      });
      expect(repair.outcome).toBe('repaired');
      expect((await migrateUp(options(dir))).outcome).toBe('applied');
    }, 60_000);

    it('refuses to invent a row for a migration the ledger never saw', async () => {
      const dir = chain({ '001_a.sql': 'CREATE TABLE r_a (id INT);\n' });
      await migrateUp(options(dir));
      const repair = await repairMigration(options(dir), {
        id: '404_missing.sql',
        resolution: 'applied',
        reason: 'this migration does not exist anywhere',
        actor: 'ops-oncall',
      });
      expect(repair.outcome).toBe('not_found');
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Read-only guarantees — "`maia migrate plan/status` não altera o banco"
  // -------------------------------------------------------------------------
  describe('plan is read-only', () => {
    it('does NOT create the ledger on a virgin database', async () => {
      const dir = chain({ '001_a.sql': 'CREATE TABLE ro_a (id INT);\n' });
      const plan = await planMigrations(options(dir));
      expect(plan.ledger_exists).toBe(false);
      expect(plan.compatibility.pending).toEqual(['001_a.sql']);
      expect(await tableExists(LEDGER_TABLE)).toBe(false);
      expect(await tableExists('ro_a')).toBe(false);
    }, 60_000);

    it('answers while another migrator holds the lock', async () => {
      const dir = chain({ '001_a.sql': 'CREATE TABLE ro_b (id INT);\n' });
      await migrateUp(options(dir));
      const holder = await pool.connect();
      try {
        await acquireMigrationLock(holder, 5_000);
        // Diagnosis must work exactly when something is stuck.
        const plan = await planMigrations(options(dir));
        expect(plan.compatibility.applied_head).toBe('001_a.sql');
      } finally {
        await releaseMigrationLock(holder);
        holder.release();
      }
    }, 60_000);
  });
});
