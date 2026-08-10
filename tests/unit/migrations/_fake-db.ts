/**
 * In-memory stand-in for a `pg` pool, good enough to exercise the migration
 * runner's ORDER OF OPERATIONS and its ledger transitions without Postgres.
 *
 * It is deliberately a behavioural fake, not a stub returning canned rows: it
 * keeps a real ledger map, honours BEGIN/COMMIT/ROLLBACK by snapshotting that
 * map, and refuses to downgrade an `applied` row (the same guard the real SQL
 * has). That is what lets the unit suite assert things like "a transactional
 * failure leaves NO ledger row" and "a no-tx failure leaves a DIRTY one" — the
 * exact properties the issue's acceptance criteria are about — on a machine
 * with no database.
 *
 * The real SQL is still exercised end-to-end in
 * `tests/integration/migrations-runner-real-db.spec.ts`.
 */
import type { LedgerEntry, LedgerStatus } from '@/migrations/types.js';

export interface FakeRow {
  id: string;
  checksum_sha256: string | null;
  checksum_source: 'computed' | 'backfilled' | null;
  status: LedgerStatus;
  started_at: string | null;
  applied_at: string | null;
  execution_ms: number | null;
  app_version: string | null;
  runner_version: string | null;
  error_class: string | null;
  repaired_at: string | null;
  repair_reason: string | null;
}

export interface FakeDbOptions {
  /** Seed ledger rows. */
  readonly rows?: readonly Partial<FakeRow>[];
  /** `false` makes `pg_try_advisory_lock` always report the lock as taken. */
  readonly lockAvailable?: boolean;
  /** Throw for a migration's SQL body. Keyed by a substring of the statement. */
  readonly failOnSql?: (sql: string) => void;
  /** Make `pool.connect()` reject. */
  readonly connectFails?: boolean;
}

function blankRow(id: string): FakeRow {
  return {
    id,
    checksum_sha256: null,
    checksum_source: null,
    status: 'applied',
    started_at: null,
    applied_at: null,
    execution_ms: null,
    app_version: null,
    runner_version: null,
    error_class: null,
    repaired_at: null,
    repair_reason: null,
  };
}

export class FakeDb {
  readonly ledger = new Map<string, FakeRow>();
  /** Every statement the runner sent, in order. */
  readonly queries: string[] = [];
  /** Migration bodies (non-ledger, non-control statements) actually executed. */
  readonly executedSql: string[] = [];
  releases = 0;
  unlocks = 0;
  connects = 0;

  private snapshot: Map<string, FakeRow> | null = null;
  private lockHeld = false;

  constructor(private readonly options: FakeDbOptions = {}) {
    for (const seed of options.rows ?? []) {
      const id = seed.id!;
      this.ledger.set(id, { ...blankRow(id), ...seed });
    }
  }

  get lockAvailable(): boolean {
    return this.options.lockAvailable !== false;
  }

  entries(): LedgerEntry[] {
    return [...this.ledger.values()].map((r) => ({ ...r }));
  }

  connect(): Promise<FakeClient> {
    this.connects += 1;
    if (this.options.connectFails) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(new FakeClient(this));
  }

  /** Dispatch a statement. Kept in one place so the fake stays auditable. */
  run(text: string, values: unknown[] = []): { rows: unknown[] } {
    this.queries.push(text);
    const t = text.trim();

    if (t.includes('pg_try_advisory_lock')) {
      const acquired = this.lockAvailable && !this.lockHeld;
      if (acquired) this.lockHeld = true;
      return { rows: [{ locked: acquired }] };
    }
    if (t.includes('pg_advisory_unlock')) {
      this.lockHeld = false;
      this.unlocks += 1;
      return { rows: [] };
    }
    if (/^SET (lock_timeout|statement_timeout) = \d+$/.test(t)) return { rows: [] };
    // Control statements are matched EXACTLY: a migration body legitimately
    // starts with `BEGIN;` of its own, and mistaking that for the runner's
    // control statement would hide the very distinction under test.
    if (t === 'BEGIN') {
      this.snapshot = new Map([...this.ledger].map(([k, v]) => [k, { ...v }]));
      return { rows: [] };
    }
    if (t === 'COMMIT') {
      this.snapshot = null;
      return { rows: [] };
    }
    if (t === 'ROLLBACK') {
      if (this.snapshot) {
        this.ledger.clear();
        for (const [k, v] of this.snapshot) this.ledger.set(k, v);
      }
      this.snapshot = null;
      return { rows: [] };
    }
    if (t.startsWith('SELECT column_name FROM information_schema.columns')) {
      return { rows: this.informationSchemaRows() };
    }
    if (
      t.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations') ||
      t.startsWith('ALTER TABLE schema_migrations') ||
      t.startsWith('DO $$')
    ) {
      return { rows: [] };
    }
    if (t.startsWith('SELECT id, checksum_sha256')) {
      return { rows: this.entries() };
    }
    if (t.startsWith('SELECT id, applied_at FROM schema_migrations')) {
      return { rows: [...this.ledger.values()].map((r) => ({ id: r.id, applied_at: r.applied_at })) };
    }
    if (t.includes("SET status = 'dirty'") && t.includes("WHERE status = 'running'")) {
      const promoted: { id: string }[] = [];
      for (const row of this.ledger.values()) {
        if (row.status === 'running') {
          row.status = 'dirty';
          row.error_class = row.error_class ?? 'orphaned_running';
          promoted.push({ id: row.id });
        }
      }
      return { rows: promoted };
    }
    if (t.includes("checksum_source = 'backfilled'") && t.includes('UNNEST')) {
      const ids = values[0] as string[];
      const sums = values[1] as string[];
      const done: { id: string }[] = [];
      ids.forEach((id, i) => {
        const row = this.ledger.get(id);
        if (row && row.status === 'applied' && row.checksum_sha256 === null) {
          row.checksum_sha256 = sums[i]!;
          row.checksum_source = 'backfilled';
          done.push({ id });
        }
      });
      return { rows: done };
    }
    if (t.startsWith('DELETE FROM schema_migrations')) {
      const id = values[0] as string;
      const row = this.ledger.get(id);
      if (row && ['dirty', 'failed', 'running'].includes(row.status)) {
        this.ledger.delete(id);
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    if (t.startsWith('UPDATE schema_migrations') && t.includes('repair_reason')) {
      const [id, checksum, reason, runnerVersion] = values as [string, string | null, string, string];
      const row = this.ledger.get(id);
      if (row && ['dirty', 'failed', 'running'].includes(row.status)) {
        row.status = 'applied';
        row.checksum_sha256 = checksum ?? row.checksum_sha256;
        row.checksum_source = 'backfilled';
        row.applied_at = row.applied_at ?? new Date().toISOString();
        row.repaired_at = new Date().toISOString();
        row.repair_reason = reason;
        row.runner_version = runnerVersion;
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    if (t.startsWith('INSERT INTO schema_migrations')) {
      return { rows: this.upsert(t, values) };
    }

    // Anything else is a migration body.
    this.executedSql.push(t);
    this.options.failOnSql?.(t);
    return { rows: [] };
  }

  private informationSchemaRows(): { column_name: string }[] {
    return [
      'id',
      'applied_at',
      'checksum_sha256',
      'checksum_source',
      'status',
      'started_at',
      'execution_ms',
      'app_version',
      'runner_version',
      'error_class',
      'repaired_at',
      'repair_reason',
    ].map((column_name) => ({ column_name }));
  }

  private upsert(text: string, values: unknown[]): unknown[] {
    const now = new Date().toISOString();
    const id = values[0] as string;
    const existing = this.ledger.get(id);

    if (text.includes("VALUES ($1, 'running'")) {
      const [, checksum, appVersion, runnerVersion] = values as [string, string, string | null, string];
      this.ledger.set(id, {
        ...(existing ?? blankRow(id)),
        status: 'running',
        checksum_sha256: checksum,
        checksum_source: 'computed',
        started_at: now,
        applied_at: null,
        app_version: appVersion,
        runner_version: runnerVersion,
        error_class: null,
      });
      return [];
    }

    if (text.includes("VALUES ($1, 'applied'")) {
      const [, checksum, executionMs, appVersion, runnerVersion] = values as [
        string,
        string,
        number,
        string | null,
        string,
      ];
      this.ledger.set(id, {
        ...(existing ?? blankRow(id)),
        status: 'applied',
        checksum_sha256: checksum,
        checksum_source: 'computed',
        started_at: existing?.started_at ?? now,
        applied_at: now,
        execution_ms: executionMs,
        app_version: appVersion,
        runner_version: runnerVersion,
        error_class: null,
      });
      return [];
    }

    // markTerminalFailure — never downgrades an applied row.
    const [, status, checksum, appVersion, runnerVersion, errorClass] = values as [
      string,
      LedgerStatus,
      string,
      string | null,
      string,
      string,
    ];
    if (existing && existing.status === 'applied') return [];
    this.ledger.set(id, {
      ...(existing ?? blankRow(id)),
      status,
      checksum_sha256: checksum,
      checksum_source: 'computed',
      applied_at: null,
      app_version: appVersion,
      runner_version: runnerVersion,
      error_class: errorClass,
    });
    return [];
  }
}

export class FakeClient {
  constructor(private readonly db: FakeDb) {}

  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    try {
      return Promise.resolve(this.db.run(text, values) as { rows: R[] });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  release(): void {
    this.db.releases += 1;
  }
}
