/**
 * Issue #516 §1/§5 — runner semantics, proven without Postgres.
 *
 * What is asserted here is the ORDER OF OPERATIONS and the LEDGER TRANSITIONS,
 * which is where every acceptance criterion of the issue lives:
 *
 *   - a transactional failure leaves NO partial change and a retryable row;
 *   - a no-transaction failure leaves a DIRTY row and stops the chain;
 *   - a crashed run's `running` row becomes dirty on the next pass;
 *   - dirty / checksum mismatch / missing file block BEFORE any SQL runs;
 *   - the lock is taken first and released in `finally`, always;
 *   - logs carry ids, short checksums and error classes — never SQL or DSNs.
 *
 * The same paths are exercised against real Postgres in
 * `tests/integration/migrations-runner-real-db.spec.ts` (needs a database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMigrations,
  repairMigration,
  repairAppliedRefusal,
  terminalLedgerStatusFor,
  RUNNER_VERSION,
} from '@/migrations/runner.js';
import { migrationChecksum } from '@/migrations/checksum.js';
import { FakeDb } from './_fake-db.js';

/**
 * `runner` mode: no transaction control of its own, so the runner's BEGIN/COMMIT
 * envelope genuinely wraps both the DDL and the ledger row. 107 of the 118
 * migrations on disk look like this.
 */
const TX_A = 'CREATE TABLE a (id TEXT);\n';
const TX_B = 'CREATE TABLE b (id TEXT);\n';
/** `self` mode: the file owns its transaction, so the ledger cannot join it. */
const SELF_TX = 'BEGIN;\nCREATE TABLE c (id TEXT);\nCOMMIT;\n';
/** `none` mode: CONCURRENTLY DDL, which Postgres refuses inside a transaction. */
const NO_TX = '-- maia:no-transaction\nCREATE INDEX CONCURRENTLY i1 ON a (id);\nCREATE INDEX CONCURRENTLY i2 ON a (id);\n';
/**
 * `self` mode WITHOUT the guarantee: the same `BEGIN;` as `SELF_TX`, but a
 * statement outside the envelope. The DDL is durable before that statement runs.
 */
const LEAKY_SELF_TX = 'BEGIN;\nCREATE TABLE c (id TEXT);\nCOMMIT;\nANALYZE c;\n';

let dir: string;

async function write(name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
  await writeFile(join(dir, name.replace(/\.sql$/, '_down.sql')), '-- down\nSELECT 1;\n', 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maia-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(db: FakeDb, events: { event: string; detail: Record<string, unknown> }[] = []) {
  let t = 0;
  return {
    pool: db as unknown as { connect: () => Promise<never> },
    migrationsDir: dir,
    appVersion: '3.1.0',
    onEvent: (event: string, detail: Record<string, unknown>) => events.push({ event, detail }),
    now: () => (t += 5),
    sleep: () => Promise.resolve(),
  } as unknown as Parameters<typeof runMigrations>[0];
}

describe('runMigrations — happy path', () => {
  it('applies pending migrations in artifact order, inside transactions', async () => {
    await write('002_b.sql', TX_B);
    await write('001_a.sql', TX_A);
    const db = new FakeDb();
    const result = await runMigrations(deps(db));

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('applied');
    expect(result.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(db.executedSql).toEqual([TX_A.trim(), TX_B.trim()]);

    // Lock first, unlock last.
    expect(db.queries[0]).toContain('pg_try_advisory_lock');
    expect(db.queries[db.queries.length - 1]).toContain('pg_advisory_unlock');
    expect(db.unlocks).toBe(1);
    expect(db.releases).toBe(1);

    // BEGIN ... migration ... ledger insert ... COMMIT, atomically.
    const bodyIdx = db.queries.findIndex((q) => q.trim() === TX_A.trim());
    const window = db.queries.slice(bodyIdx - 1);
    expect(window[0]).toBe('BEGIN');
    expect(window[2]).toContain('INSERT INTO schema_migrations');
    expect(window[3]).toBe('COMMIT');

    const row = db.ledger.get('001_a.sql')!;
    expect(row.status).toBe('applied');
    expect(row.checksum_sha256).toBe(migrationChecksum(TX_A));
    expect(row.checksum_source).toBe('computed');
    expect(row.runner_version).toBe(RUNNER_VERSION);
    expect(row.app_version).toBe('3.1.0');
    expect(row.execution_ms).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op on the second run', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb();
    await runMigrations(deps(db));
    db.executedSql.length = 0;
    const again = await runMigrations(deps(db));
    expect(again.outcome).toBe('up_to_date');
    expect(again.applied).toEqual([]);
    expect(db.executedSql).toEqual([]);
  });

  it('sets a lock_timeout before touching the schema', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb();
    await runMigrations(deps(db));
    expect(db.queries.some((q) => q.startsWith('SET lock_timeout = 10000'))).toBe(true);
    expect(db.queries.some((q) => q.startsWith('SET statement_timeout = 0'))).toBe(true);
  });

  it('honours a per-migration statement-timeout marker', async () => {
    await write('001_a.sql', `-- maia:statement-timeout=120000\n${TX_A}`);
    const db = new FakeDb();
    await runMigrations(deps(db));
    expect(db.queries.some((q) => q === 'SET statement_timeout = 120000')).toBe(true);
  });
});

describe('runMigrations — no-transaction path', () => {
  it('records `running` BEFORE the first statement and sends statements one by one', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb();
    const result = await runMigrations(deps(db));
    expect(result.applied).toEqual(['001_idx.sql']);
    expect(db.executedSql).toEqual([
      'CREATE INDEX CONCURRENTLY i1 ON a (id)',
      'CREATE INDEX CONCURRENTLY i2 ON a (id)',
    ]);
    // No implicit transaction wrapping — that is what CONCURRENTLY rejects.
    expect(db.queries).not.toContain('BEGIN');
    const runningIdx = db.queries.findIndex((q) => q.includes("VALUES ($1, 'running'"));
    const firstStmt = db.queries.indexOf('CREATE INDEX CONCURRENTLY i1 ON a (id)');
    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(firstStmt);
    expect(db.ledger.get('001_idx.sql')!.status).toBe('applied');
  });

  it('leaves a DIRTY row when a statement fails, and does not attempt the next migration', async () => {
    await write('001_idx.sql', NO_TX);
    await write('002_b.sql', TX_B);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb({
      failOnSql: (sql) => {
        if (sql.includes('i2')) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      },
    });
    const result = await runMigrations(deps(db, events));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.failure).toEqual({
      id: '001_idx.sql',
      error_class: '40P01',
      ledger_status: 'dirty',
    });
    expect(db.ledger.get('001_idx.sql')!.status).toBe('dirty');
    expect(db.ledger.get('001_idx.sql')!.error_class).toBe('40P01');
    // The chain stops: 002 was never attempted.
    expect(db.ledger.has('002_b.sql')).toBe(false);
    expect(db.executedSql).not.toContain(TX_B.trim());
    expect(events.map((e) => e.event)).toContain('migration.dirty');
    // Lock released even on the failure path.
    expect(db.unlocks).toBe(1);
  });

  it('blocks every subsequent run while the dirty row stands', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty', checksum_sha256: migrationChecksum(NO_TX) }] });
    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('dirty_migration');
    expect(db.executedSql).toEqual([]);
  });
});

describe('runMigrations — self-transactional path (the atomicity gap made visible)', () => {
  it('does NOT wrap a self-transactional file, and commits `running` first', async () => {
    await write('001_self.sql', SELF_TX);
    const db = new FakeDb();
    const result = await runMigrations(deps(db));

    expect(result.applied).toEqual(['001_self.sql']);
    // No outer BEGIN: nesting it is what silently broke the ledger's atomicity.
    expect(db.queries).not.toContain('BEGIN');
    const runningIdx = db.queries.findIndex((q) => q.includes("VALUES ($1, 'running'"));
    expect(runningIdx).toBeLessThan(db.queries.findIndex((q) => q.trim() === SELF_TX.trim()));
    expect(db.ledger.get('001_self.sql')!.status).toBe('applied');
  });

  it('records a clean failure as `failed` (the file rolled itself back), not dirty', async () => {
    await write('001_self.sql', SELF_TX);
    const db = new FakeDb({
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE c')) throw Object.assign(new Error('x'), { code: '42P07' });
      },
    });
    const result = await runMigrations(deps(db));
    expect(result.failure?.ledger_status).toBe('failed');
    // The session's aborted transaction is cleared before touching the ledger.
    expect(db.queries).toContain('ROLLBACK');
    expect(db.ledger.get('001_self.sql')!.status).toBe('failed');
  });

  it('a crash mid-file leaves `running`, which the next run turns into dirty', async () => {
    await write('001_self.sql', SELF_TX);
    // Simulates the process dying after `running` was committed.
    const db = new FakeDb({ rows: [{ id: '001_self.sql', status: 'running' }] });
    const result = await runMigrations(deps(db));
    expect(result.orphaned).toEqual(['001_self.sql']);
    expect(result.outcome).toBe('blocked');
    expect(db.ledger.get('001_self.sql')!.status).toBe('dirty');
  });
});

describe('runMigrations — transactional failure', () => {
  it('rolls back and records `failed` (retryable), leaving no ledger row behind', async () => {
    await write('001_a.sql', TX_A);
    await write('002_b.sql', TX_B);
    const db = new FakeDb({
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE a')) throw Object.assign(new Error('relation exists'), { code: '42P07' });
      },
    });
    const result = await runMigrations(deps(db));

    expect(result.outcome).toBe('failed');
    expect(result.failure?.ledger_status).toBe('failed');
    expect(db.queries).toContain('ROLLBACK');
    // The `failed` row is written AFTER the rollback (outside the transaction),
    // otherwise it would have been rolled back with everything else.
    expect(db.ledger.get('001_a.sql')!.status).toBe('failed');
    expect(db.ledger.get('001_a.sql')!.applied_at).toBeNull();
    expect(db.ledger.has('002_b.sql')).toBe(false);
  });

  it('a failed row is retried on the next run rather than demanding a repair', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ rows: [{ id: '001_a.sql', status: 'failed', error_class: '42P07' }] });
    const result = await runMigrations(deps(db));
    expect(result.applied).toEqual(['001_a.sql']);
    expect(db.ledger.get('001_a.sql')!.status).toBe('applied');
  });

  it('never downgrades an already-applied row when recording a failure', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({
      rows: [{ id: '001_a.sql', status: 'applied', checksum_sha256: migrationChecksum(TX_A), checksum_source: 'computed' }],
    });
    await runMigrations(deps(db));
    expect(db.ledger.get('001_a.sql')!.status).toBe('applied');
  });
});

describe('runMigrations — fail-closed gates', () => {
  it('refuses to apply anything when an applied migration was edited', async () => {
    await write('001_a.sql', TX_A);
    await write('002_b.sql', TX_B);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb({
      rows: [{ id: '001_a.sql', status: 'applied', checksum_sha256: 'f'.repeat(64), checksum_source: 'computed' }],
    });
    const result = await runMigrations(deps(db, events));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
    expect(db.executedSql).toEqual([]);
    expect(events.map((e) => e.event)).toContain('migration.checksum_mismatch');
    expect(db.unlocks).toBe(1);
  });

  it('refuses when the database ran a migration this build does not ship', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({
      rows: [
        { id: '001_a.sql', status: 'applied', checksum_sha256: migrationChecksum(TX_A), checksum_source: 'computed' },
        { id: '099_ghost.sql', status: 'applied', checksum_sha256: 'a'.repeat(64), checksum_source: 'computed' },
      ],
    });
    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('missing_file');
  });

  it('refuses when a forward migration has no _down sibling', async () => {
    await writeFile(join(dir, '001_a.sql'), TX_A, 'utf8');
    const db = new FakeDb();
    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('artifact_integrity');
    expect(db.executedSql).toEqual([]);
  });

  it('refuses to migrate when the lock cannot be taken — never unguarded', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ lockAvailable: false });
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const result = await runMigrations(deps(db, events), { waitMs: 1000, pollMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('lock_unavailable');
    expect(db.executedSql).toEqual([]);
    expect(events.map((e) => e.event)).toContain('migration.lock_unavailable');
  });
});

describe('runMigrations — crash recovery and checksum adoption', () => {
  it('promotes a crashed `running` row to dirty and then blocks', async () => {
    await write('001_idx.sql', NO_TX);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'running' }] });
    const result = await runMigrations(deps(db, events));

    expect(result.orphaned).toEqual(['001_idx.sql']);
    expect(db.ledger.get('001_idx.sql')!.status).toBe('dirty');
    expect(db.ledger.get('001_idx.sql')!.error_class).toBe('orphaned_running');
    expect(result.outcome).toBe('blocked');
    expect(db.executedSql).toEqual([]);
    expect(events.find((e) => e.event === 'migration.dirty')?.detail.cause).toBe('orphaned_running');
  });

  it('adopts checksums for pre-checksum rows and marks them `backfilled`', async () => {
    await write('001_a.sql', TX_A);
    await write('002_b.sql', TX_B);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    // A v1-runner row: applied, no checksum.
    const db = new FakeDb({ rows: [{ id: '001_a.sql', status: 'applied' }] });
    const result = await runMigrations(deps(db, events));

    expect(result.backfilled).toEqual(['001_a.sql']);
    expect(db.ledger.get('001_a.sql')!.checksum_sha256).toBe(migrationChecksum(TX_A));
    expect(db.ledger.get('001_a.sql')!.checksum_source).toBe('backfilled');
    // Adoption unblocks the run: 002 is applied in the same pass.
    expect(result.applied).toEqual(['002_b.sql']);
    expect(events.map((e) => e.event)).toContain('migration.checksum_backfilled');
  });

  it('after adoption, a later edit of the same file blocks', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ rows: [{ id: '001_a.sql', status: 'applied' }] });
    await runMigrations(deps(db));
    // Someone edits the merged migration.
    await write('001_a.sql', `${TX_A}-- sneaky\n`);
    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
  });

  it('does NOT adopt a checksum for a ledger row with no packaged file', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ rows: [{ id: '099_ghost.sql', status: 'applied' }] });
    const result = await runMigrations(deps(db));
    expect(result.backfilled).toEqual([]);
    expect(db.ledger.get('099_ghost.sql')!.checksum_sha256).toBeNull();
  });
});

describe('runMigrations — log hygiene', () => {
  it('emits ids, short checksums, durations and error classes only', async () => {
    await write('001_a.sql', TX_A);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    await runMigrations(deps(new FakeDb(), events));

    const names = events.map((e) => e.event);
    expect(names).toContain('migration.started');
    expect(names).toContain('migration.applied');

    const applied = events.find((e) => e.event === 'migration.applied')!;
    expect(applied.detail.migration_id).toBe('001_a.sql');
    expect(applied.detail.checksum).toBe(migrationChecksum(TX_A).slice(0, 12));
    expect(typeof applied.detail.duration_ms).toBe('number');

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('CREATE TABLE');
    expect(serialised).not.toMatch(/postgres:\/\//);
    // The full 64-char digest never appears — only the abbreviation.
    expect(serialised).not.toContain(migrationChecksum(TX_A));
  });

  it('never puts a driver message in a failure event', async () => {
    await write('001_a.sql', TX_A);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb({
      failOnSql: () => {
        throw Object.assign(new Error('connection to postgres://maia:hunter2@db:5432 failed'), {
          code: '08006',
        });
      },
    });
    await runMigrations(deps(db, events));
    const serialised = JSON.stringify(events);
    expect(serialised).toContain('08006');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toMatch(/postgres:\/\//);
  });
});

describe('repairMigration', () => {
  it('refuses without a reason — the reason IS the audit trail', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), { id: '001_idx.sql', outcome: 'applied', reason: '   ' });
    expect(result.ok).toBe(false);
    expect(db.ledger.get('001_idx.sql')!.status).toBe('dirty');
  });

  it('closes a dirty row as applied, stamping the reason', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), {
      id: '001_idx.sql',
      outcome: 'applied',
      reason: 'verified both indexes exist (issue 516 drill)',
    });
    expect(result.ok).toBe(true);
    const row = db.ledger.get('001_idx.sql')!;
    expect(row.status).toBe('applied');
    expect(row.repair_reason).toBe('verified both indexes exist (issue 516 drill)');
    expect(row.repaired_at).not.toBeNull();
    // Adopted, not verified at apply time.
    expect(row.checksum_source).toBe('backfilled');
    expect(row.checksum_sha256).toBe(migrationChecksum(NO_TX));
  });

  it('resets a dirty row to pending so the migration re-runs from scratch', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), {
      id: '001_idx.sql',
      outcome: 'pending',
      reason: 'dropped the half-built index by hand',
    });
    expect(result.ok).toBe(true);
    expect(db.ledger.has('001_idx.sql')).toBe(false);

    const rerun = await runMigrations(deps(db));
    expect(rerun.applied).toEqual(['001_idx.sql']);
  });

  it('refuses to rewrite a healthy applied row', async () => {
    await write('001_a.sql', TX_A);
    const db = new FakeDb({
      rows: [{ id: '001_a.sql', status: 'applied', checksum_sha256: migrationChecksum(TX_A), checksum_source: 'computed' }],
    });
    const result = await repairMigration(deps(db), { id: '001_a.sql', outcome: 'pending', reason: 'oops' });
    expect(result.ok).toBe(false);
    expect(db.ledger.get('001_a.sql')!.status).toBe('applied');
  });

  it('takes and releases the global lock', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    await repairMigration(deps(db), { id: '001_idx.sql', outcome: 'applied', reason: 'verified' });
    expect(db.queries[0]).toContain('pg_try_advisory_lock');
    expect(db.unlocks).toBe(1);
    expect(db.releases).toBe(1);
  });
});

/**
 * The medium finding from the #541 review.
 *
 * With no packaged file there is no checksum, so `repairEntry`'s
 * `COALESCE($2, checksum_sha256)` left the row's checksum NULL while still
 * flipping it to `applied` and stamping `checksum_source = 'backfilled'` — and
 * `repairMigration` returned `ok: true`. The next `status`/`up` blocked again
 * on `missing_file` / `checksum_unknown` for that same id, so the operator was
 * told "repaired" while readiness had not moved at all.
 */
describe('repairMigration — `--as applied` demands something verifiable', () => {
  it('refuses when this build does not package the migration, and does NOT touch the row', async () => {
    await write('001_a.sql', TX_A);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb({ rows: [{ id: '099_ghost.sql', status: 'dirty' }] });

    const result = await repairMigration(deps(db, events), {
      id: '099_ghost.sql',
      outcome: 'applied',
      reason: 'schema conferido a mao',
    });

    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      reason: repairAppliedRefusal('099_ghost.sql', 'artifact_missing'),
    });
    // The ledger is exactly as it was: still dirty, still blocking, still NULL.
    const row = db.ledger.get('099_ghost.sql')!;
    expect(row.status).toBe('dirty');
    expect(row.checksum_sha256).toBeNull();
    expect(row.checksum_source).toBeNull();
    expect(row.repaired_at).toBeNull();
    expect(row.repair_reason).toBeNull();
    // No "repaired" event: nothing was repaired.
    expect(events.map((e) => e.event)).not.toContain('migration.repaired');
  });

  it('refuses BEFORE taking the lock or writing any DDL', async () => {
    // A refusal during an incident must not contend with a running migrator,
    // and must not bootstrap a ledger it is about to refuse to write to.
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ rows: [{ id: '099_ghost.sql', status: 'dirty' }] });
    await repairMigration(deps(db), {
      id: '099_ghost.sql',
      outcome: 'applied',
      reason: 'schema conferido a mao',
    });
    expect(db.queries).toEqual([]);
    expect(db.unlocks).toBe(0);
    expect(db.releases).toBe(0);
  });

  it('names what is missing AND what to do instead — `--as pending`', () => {
    const reason = repairAppliedRefusal('099_ghost.sql', 'artifact_missing');
    // Diagnosis: the id, the rule, and the state it would still be stuck in.
    expect(reason).toContain('repair --as applied refused for "099_ghost.sql"');
    expect(reason).toContain('[repair/artifact_missing]');
    expect(reason).toContain('this build does not package migrations/099_ghost.sql');
    expect(reason).toContain('blocks again on missing_file');
    // Remediation, both branches, as runnable commands.
    expect(reason).toContain('Run the repair from a build that ships 099_ghost.sql');
    expect(reason).toContain('migrate repair --id 099_ghost.sql --as pending --reason');

    const unknown = repairAppliedRefusal('001_a.sql', 'checksum_missing');
    expect(unknown).toContain('[repair/checksum_missing]');
    expect(unknown).toContain('blocks again on checksum_unknown');
  });

  it('still accepts `--as applied` when the file IS packaged', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), {
      id: '001_idx.sql',
      outcome: 'applied',
      reason: 'os dois indices existem e sao validos',
    });
    expect(result.ok).toBe(true);
    expect(db.ledger.get('001_idx.sql')!.checksum_sha256).toBe(migrationChecksum(NO_TX));
  });

  it('keeps `--as pending` available for the unpackaged row — the actual remediation', async () => {
    // `pending` needs nothing to verify: it DELETES the row instead of
    // certifying it, so it is the right answer precisely when `applied` is not.
    await write('001_a.sql', TX_A);
    const db = new FakeDb({ rows: [{ id: '099_ghost.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), {
      id: '099_ghost.sql',
      outcome: 'pending',
      reason: 'efeitos desfeitos a mao; migration nao pertence a este build',
    });
    expect(result.ok).toBe(true);
    expect(db.ledger.has('099_ghost.sql')).toBe(false);
  });

  it('refuses an empty reason before it ever looks at the artifact', async () => {
    await write('001_idx.sql', NO_TX);
    const db = new FakeDb({ rows: [{ id: '001_idx.sql', status: 'dirty' }] });
    const result = await repairMigration(deps(db), {
      id: '001_idx.sql',
      outcome: 'applied',
      reason: ' ',
    });
    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('non-empty --reason'),
    });
  });
});

/**
 * Finding 1 of the #541 review — the failure path returned a status snapshot
 * taken BEFORE the loop ran.
 *
 * `MigrationStatusReport` is contracted as the complete description of artifact
 * × database. Returning the pre-loop snapshot next to a `failure` field
 * produced a self-contradictory result: `failure.ledger_status = "dirty"` beside
 * an entry still classified `pending`, and migrations this very run had applied
 * listed as pending too. `maia doctor` and any automation reading `status`
 * would then remediate a database that no longer exists.
 */
describe('runMigrations — `status` on the failure path describes the ledger AFTER the run', () => {
  const TX_C = 'CREATE TABLE c2 (id TEXT);\n';

  it('transactional failure: applied → applied, failed → failed, untouched → pending', async () => {
    await write('001_a.sql', TX_A);
    await write('002_bad.sql', TX_B);
    await write('003_c.sql', TX_C);
    const db = new FakeDb({
      failOnSql: (sql) => {
        if (sql.includes('CREATE TABLE b')) throw Object.assign(new Error('boom'), { code: '42P07' });
      },
    });

    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('failed');
    expect(result.applied).toEqual(['001_a.sql']);
    expect(result.failure).toEqual({
      id: '002_bad.sql',
      error_class: '42P07',
      ledger_status: 'failed',
    });

    const status = result.status!;
    const state = (id: string) => status.entries.find((e) => e.id === id)!.state;
    // The migration this run applied is NOT still pending.
    expect(state('001_a.sql')).toBe('applied');
    // The failure is visible in the report, not only in `failure`.
    expect(state('002_bad.sql')).toBe('failed');
    expect(state('003_c.sql')).toBe('pending');
    expect(status.counts).toMatchObject({ total: 3, applied: 1, failed: 1, pending: 1, dirty: 0 });
    expect(status.applied_head).toBe('001_a.sql');
    // `status` and `failure` cannot disagree about the same id.
    expect(state(result.failure!.id)).toBe(result.failure!.ledger_status);
  });

  it('no-transaction failure: the dirty row is dirty in `status.entries` too', async () => {
    await write('001_a.sql', TX_A);
    await write('002_idx.sql', NO_TX);
    await write('003_b.sql', TX_B);
    const db = new FakeDb({
      failOnSql: (sql) => {
        if (sql.includes('i2')) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      },
    });

    const result = await runMigrations(deps(db));
    expect(result.failure).toEqual({
      id: '002_idx.sql',
      error_class: '40P01',
      ledger_status: 'dirty',
    });

    const status = result.status!;
    const entry = (id: string) => status.entries.find((e) => e.id === id)!;
    expect(entry('001_a.sql').state).toBe('applied');
    expect(entry('002_idx.sql').state).toBe('dirty');
    // And it carries the blocking bit, so a consumer does not have to re-derive
    // that this schema must not take traffic.
    expect(entry('002_idx.sql').blocking).toBe(true);
    expect(entry('002_idx.sql').error_class).toBe('40P01');
    expect(entry('003_b.sql').state).toBe('pending');
    expect(status.counts).toMatchObject({ total: 3, applied: 1, dirty: 1, pending: 1, failed: 0 });
    expect(status.applied_head).toBe('001_a.sql');
    expect(entry(result.failure!.id).state).toBe(result.failure!.ledger_status);
  });

  it('the success path reports the same way — no migration it applied is left pending', async () => {
    await write('001_a.sql', TX_A);
    await write('002_b.sql', TX_B);
    const db = new FakeDb();
    const result = await runMigrations(deps(db));
    expect(result.status!.pending).toEqual([]);
    expect(result.status!.counts).toMatchObject({ total: 2, applied: 2, pending: 0 });
  });
});

/**
 * Finding 2 of the #541 review — `BEGIN;` is not proof of atomicity.
 *
 * `BEGIN; … COMMIT; <statement>` was classified `self`, so a failure in that
 * trailing statement was recorded as `failed`, i.e. AUTO-RETRIED, even though
 * the DDL inside the envelope had already committed and the runner's `ROLLBACK`
 * had nothing to undo. The property is now proven per file at discovery, and
 * anything unproven fails closed.
 */
describe('runMigrations — the self-transactional envelope guardrail', () => {
  it('refuses a `self` file whose SQL is not one complete envelope, before any DDL', async () => {
    await write('001_leaky.sql', LEAKY_SELF_TX);
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const db = new FakeDb();

    const result = await runMigrations(deps(db, events));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('blocked');
    const blocker = result.blockers.find((b) => b.id === '001_leaky.sql')!;
    expect(blocker.kind).toBe('artifact_integrity');
    expect(blocker.detail).toContain('statement_after_commit');
    // Nothing ran and nothing was recorded: the refusal precedes the schema.
    expect(db.executedSql).toEqual([]);
    expect(db.ledger.has('001_leaky.sql')).toBe(false);
    expect(events.map((e) => e.event)).toContain('migration.blocked');
    // The lock is still released.
    expect(db.unlocks).toBe(1);
  });

  it('still applies the well-formed envelope it is modelled on', async () => {
    await write('001_self.sql', SELF_TX);
    const db = new FakeDb();
    const result = await runMigrations(deps(db));
    expect(result.outcome).toBe('applied');
    expect(result.blockers).toEqual([]);
  });

  it('classifies a terminal failure from the PROVEN envelope, not from `BEGIN;`', () => {
    // The runner wraps it, so the ledger row rolls back with the DDL.
    expect(
      terminalLedgerStatusFor({ transactionMode: 'runner', transactionEnvelope: 'absent' }),
    ).toBe('failed');
    // One complete envelope: the error aborts it and the trailing COMMIT
    // degrades to a rollback, so retrying really is safe.
    expect(
      terminalLedgerStatusFor({ transactionMode: 'self', transactionEnvelope: 'single_complete' }),
    ).toBe('failed');
    // Own transaction control that proves nothing ⇒ fail closed.
    expect(
      terminalLedgerStatusFor({ transactionMode: 'self', transactionEnvelope: 'unverifiable' }),
    ).toBe('dirty');
    // No transaction at all: a partial change is the expected failure mode.
    expect(terminalLedgerStatusFor({ transactionMode: 'none', transactionEnvelope: 'absent' })).toBe(
      'dirty',
    );
  });
});
