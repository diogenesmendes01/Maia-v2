/**
 * Ledger v2 (issue #516 §2) — `schema_migrations` plus the append-only
 * operational trail in `schema_migration_events`.
 *
 * The ledger is the PRIMARY operational record for migrations, not `audit_log`:
 * migrations run before the audit tables exist on a fresh database, and a
 * runner whose success depended on the audit table could not create it.
 *
 * WHAT IS NEVER PERSISTED HERE: the migration SQL, driver messages, or any
 * string that could carry a connection string. Failures are recorded as an
 * error CLASS (a SQLSTATE like `42P07`, or an error name) — enough to route an
 * operator to the right runbook section, not enough to leak a DSN.
 *
 * BOOTSTRAP: `ensureLedger()` creates the v2 shape idempotently, because the
 * ledger has to exist before the migration that declares it (110) can be
 * recorded in it. Migration 110 is the append-only, reviewable statement of
 * the same shape and is written to be a no-op when this ran first.
 */
import type { PoolClient } from 'pg';
import type { ChecksumSource, DiscoveredMigration, LedgerRow, LedgerStatus } from './types.js';
import { MIGRATION_RUNNER_VERSION } from './types.js';

export const LEDGER_TABLE = 'schema_migrations';
export const EVENTS_TABLE = 'schema_migration_events';

/** Postgres SQLSTATE for `undefined_table` — a database with no ledger yet. */
const UNDEFINED_TABLE = '42P01';
/** Postgres SQLSTATE for `undefined_column` — a v1 ledger, pre-110. */
const UNDEFINED_COLUMN = '42703';

/** Events worth keeping forever. Routine success lives in the ledger itself. */
export type LedgerEvent =
  | 'lock_wait'
  | 'lock_timeout'
  | 'blocked'
  | 'dirty'
  | 'failed'
  | 'checksum_mismatch'
  | 'backfill'
  | 'stale_running_reset'
  | 'repair';

export interface RunnerContext {
  /** Build identity (`MAIA_BUILD_COMMIT`), or `null` when not injected. */
  readonly appVersion: string | null;
}

/** SQLSTATE (preferred) or constructor name. NEVER a message. */
export function errorClassOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0 && code.length <= 12) return code;
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && name.length > 0) return name.slice(0, 64);
  return 'UnknownError';
}

function sqlstate(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Create (or upgrade in place) the v2 ledger. Idempotent and safe to run on a
 * database created by the pre-#516 runner.
 *
 * `applied_at` loses its NOT NULL because a `running` row has not been applied
 * yet and stamping it with `now()` would make the ledger lie. The column DEFAULT
 * stays, so the OLD runner's `INSERT INTO schema_migrations (id) VALUES ($1)`
 * keeps working unchanged — that is the documented v2→v1 fallback.
 */
export async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    ALTER TABLE ${LEDGER_TABLE}
      ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
      ADD COLUMN IF NOT EXISTS checksum_source TEXT,
      ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'applied',
      ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS execution_ms    INTEGER,
      ADD COLUMN IF NOT EXISTS app_version     TEXT,
      ADD COLUMN IF NOT EXISTS runner_version  TEXT,
      ADD COLUMN IF NOT EXISTS error_class     TEXT;
  `);
  await client.query(`ALTER TABLE ${LEDGER_TABLE} ALTER COLUMN applied_at DROP NOT NULL;`);
  await client.query(`
    DO $ledger$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'schema_migrations_status_check'
      ) THEN
        ALTER TABLE ${LEDGER_TABLE}
          ADD CONSTRAINT schema_migrations_status_check
          CHECK (status IN ('running','applied','dirty','failed'));
      END IF;
    END
    $ledger$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS schema_migrations_unhealthy_idx
      ON ${LEDGER_TABLE} (status) WHERE status <> 'applied';
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      event        TEXT NOT NULL,
      migration_id TEXT,
      actor        TEXT,
      reason       TEXT,
      detail       JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS schema_migration_events_occurred_idx
      ON ${EVENTS_TABLE} (occurred_at DESC);
  `);
}

/**
 * Normalise one raw row into the v2 shape.
 *
 * Tolerates a v1 row (no `status` column at all): a row that exists in a v1
 * ledger was written by the old runner only AFTER its SQL succeeded, so
 * `applied` is the correct reading. Pure, so the mapping is unit-testable.
 */
export function mapLedgerRow(raw: Record<string, unknown>): LedgerRow {
  const status = typeof raw.status === 'string' ? raw.status : null;
  const asDate = (v: unknown): Date | null =>
    v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const asInt = (v: unknown): number | null =>
    typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : null;

  return {
    id: String(raw.id),
    applied_at: asDate(raw.applied_at),
    checksum_sha256: asString(raw.checksum_sha256),
    checksum_source: (asString(raw.checksum_source) as ChecksumSource | null) ?? null,
    status:
      status === 'running' || status === 'dirty' || status === 'failed' ? status : 'applied',
    started_at: asDate(raw.started_at),
    execution_ms: asInt(raw.execution_ms),
    app_version: asString(raw.app_version),
    runner_version: asString(raw.runner_version),
    error_class: asString(raw.error_class),
  };
}

export interface LedgerSnapshot {
  /** `false` when `schema_migrations` does not exist yet (virgin database). */
  readonly exists: boolean;
  readonly rows: LedgerRow[];
}

/** Read the whole ledger. READ-ONLY: never creates or upgrades anything. */
export async function readLedger(client: PoolClient): Promise<LedgerSnapshot> {
  try {
    const res = await client.query(`SELECT * FROM ${LEDGER_TABLE}`);
    return { exists: true, rows: res.rows.map((r) => mapLedgerRow(r as Record<string, unknown>)) };
  } catch (err) {
    if (sqlstate(err) === UNDEFINED_TABLE) return { exists: false, rows: [] };
    throw err;
  }
}

/** Append one operational event. Best-effort: never fails the caller. */
export async function recordEvent(
  client: PoolClient,
  event: LedgerEvent,
  fields: {
    migrationId?: string | null;
    actor?: string | null;
    reason?: string | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO ${EVENTS_TABLE} (event, migration_id, actor, reason, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        event,
        fields.migrationId ?? null,
        fields.actor ?? null,
        fields.reason ?? null,
        JSON.stringify(fields.detail ?? {}),
      ],
    );
  } catch (err) {
    // The events table is a trail, not a gate. A fresh database that has not
    // reached `ensureLedger` yet must still be able to run migrations.
    if (sqlstate(err) === UNDEFINED_TABLE || sqlstate(err) === UNDEFINED_COLUMN) return;
    throw err;
  }
}

/** Mark a migration as in flight. Called OUTSIDE the migration's transaction. */
export async function markRunning(
  client: PoolClient,
  migration: DiscoveredMigration,
  ctx: RunnerContext,
): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (id, applied_at, checksum_sha256, checksum_source, status, started_at,
        execution_ms, app_version, runner_version, error_class)
     VALUES ($1, NULL, $2, 'runner', 'running', now(), NULL, $3, $4, NULL)
     ON CONFLICT (id) DO UPDATE SET
       applied_at      = NULL,
       checksum_sha256 = EXCLUDED.checksum_sha256,
       checksum_source = 'runner',
       status          = 'running',
       started_at      = now(),
       execution_ms    = NULL,
       app_version     = EXCLUDED.app_version,
       runner_version  = EXCLUDED.runner_version,
       error_class     = NULL`,
    [migration.id, migration.checksum, ctx.appVersion, MIGRATION_RUNNER_VERSION],
  );
}

/**
 * Mark a migration applied.
 *
 * For a transactional migration this MUST be issued on the same client, inside
 * the same `BEGIN/COMMIT` as the DDL — that is what makes "applied" and "the
 * schema changed" a single atomic fact.
 */
export async function markApplied(
  client: PoolClient,
  migration: DiscoveredMigration,
  ctx: RunnerContext,
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (id, applied_at, checksum_sha256, checksum_source, status, started_at,
        execution_ms, app_version, runner_version, error_class)
     VALUES ($1, now(), $2, 'runner', 'applied', now(), $3, $4, $5, NULL)
     ON CONFLICT (id) DO UPDATE SET
       applied_at      = now(),
       checksum_sha256 = EXCLUDED.checksum_sha256,
       checksum_source = 'runner',
       status          = 'applied',
       execution_ms    = EXCLUDED.execution_ms,
       app_version     = EXCLUDED.app_version,
       runner_version  = EXCLUDED.runner_version,
       error_class     = NULL`,
    [migration.id, migration.checksum, durationMs, ctx.appVersion, MIGRATION_RUNNER_VERSION],
  );
}

/** Record a terminal non-success state. `dirty` ⇒ partial, unverified schema. */
export async function markTerminal(
  client: PoolClient,
  id: string,
  status: Extract<LedgerStatus, 'dirty' | 'failed'>,
  errorClass: string,
  durationMs: number,
): Promise<void> {
  await client.query(
    `UPDATE ${LEDGER_TABLE}
        SET status = $2, error_class = $3, execution_ms = $4, applied_at = NULL
      WHERE id = $1`,
    [id, status, errorClass, durationMs],
  );
}

/** Drop a row so the migration becomes plain "pending" again. */
export async function clearRow(client: PoolClient, id: string): Promise<void> {
  await client.query(`DELETE FROM ${LEDGER_TABLE} WHERE id = $1`, [id]);
}

/**
 * Adopt checksums for rows that predate the v2 ledger (issue #516 §2).
 *
 * Trusted EXACTLY ONCE, from the artifact present at backfill time, and
 * stamped `backfilled` so the provenance stays visible forever. After this,
 * any divergence on those same rows is a blocker like any other.
 *
 * Only touches rows that are `applied` and have NO checksum. Never overwrites
 * a checksum the runner itself wrote — that would turn the whole mechanism
 * into a rubber stamp.
 */
export async function backfillChecksums(
  client: PoolClient,
  migrations: readonly DiscoveredMigration[],
  rows: readonly LedgerRow[],
): Promise<string[]> {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const targets = rows.filter(
    (r) => r.status === 'applied' && r.checksum_sha256 === null && byId.has(r.id),
  );
  for (const row of targets) {
    await client.query(
      `UPDATE ${LEDGER_TABLE}
          SET checksum_sha256 = $2, checksum_source = 'backfilled',
              runner_version = COALESCE(runner_version, $3)
        WHERE id = $1 AND checksum_sha256 IS NULL`,
      [row.id, byId.get(row.id)!.checksum, MIGRATION_RUNNER_VERSION],
    );
  }
  return targets.map((r) => r.id);
}

/** Write an explicit, audited repair decision. */
export async function applyRepair(
  client: PoolClient,
  id: string,
  resolution: 'applied' | 'pending',
  checksum: string | null,
  actor: string,
  reason: string,
): Promise<void> {
  if (resolution === 'pending') {
    await clearRow(client, id);
  } else {
    await client.query(
      `UPDATE ${LEDGER_TABLE}
          SET status = 'applied',
              applied_at = now(),
              error_class = NULL,
              checksum_sha256 = COALESCE($2, checksum_sha256),
              checksum_source = 'repair'
        WHERE id = $1`,
      [id, checksum],
    );
  }
  await recordEvent(client, 'repair', {
    migrationId: id,
    actor,
    reason,
    detail: { resolution },
  });
}
