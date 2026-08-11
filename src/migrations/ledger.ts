/**
 * Issue #516 §2 — the migration ledger (`schema_migrations`), v2.
 *
 * The ledger is the PRIMARY operational trail for migrations: it has to work
 * before `audit_logs` exists (migration 001 is what creates the audited world),
 * so it cannot depend on the audit stack.
 *
 * v1 (pre-#516) recorded `id` + `applied_at` only. v2 adds the columns that
 * make an applied history verifiable and a partial failure representable:
 * checksum (+ how it was obtained), lifecycle status, timings, and the
 * provenance of the run that wrote the row.
 *
 * ### Why the DDL lives here AND in migration 108
 *
 * Chicken-and-egg: the ledger must exist before the FIRST migration runs, so it
 * cannot be created by a migration. The pre-#516 runner already solved this
 * with a `CREATE TABLE IF NOT EXISTS` bootstrap; v2 keeps that shape and
 * extends it with `ADD COLUMN IF NOT EXISTS`.
 *
 * `migrations/108_schema_migrations_v2.sql` ships the SAME idempotent DDL, so
 * the change is reviewable and reversible like every other schema change
 * (AGENTS.md §4 rule 6 — and the issue's DoD asks for ledger v2 "aplicado com
 * `_up` e `_down`"). Whichever runs first wins; the other is a no-op. The two
 * are kept in sync by `tests/unit/migrations/ledger-schema-parity.spec.ts`.
 *
 * ### Backward compatibility with the v1 runner
 *
 * Rollback safety (issue §Rollback: "O ledger v2 deve permanecer legível pelo
 * runner anterior"). The v1 runner does `SELECT id` and
 * `INSERT INTO schema_migrations (id) VALUES ($1)`. Both still work against v2:
 * every added column is nullable or defaulted, and `applied_at` keeps its
 * `DEFAULT now()`. Its inserts land as `status='applied'` with a NULL checksum
 * — which the v2 runner then treats as `checksum_unknown` (blocking) until a
 * backfill adopts the packaged checksum.
 *
 * ### Scope
 *
 * Global, not tenant-scoped: DDL applies to the whole database. See `types.ts`.
 */
import type { ChecksumSource, LedgerEntry, LedgerStatus, MigrationArtifact } from './types.js';

export const LEDGER_TABLE = 'schema_migrations';

/** Columns v2 adds on top of the v1 `(id, applied_at)` shape. */
export const LEDGER_V2_COLUMNS = [
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
] as const;

/**
 * Idempotent bootstrap DDL. Statement-per-entry so a caller can send them one
 * at a time (node-postgres wraps a multi-statement `query()` in an implicit
 * transaction, which is fine here but keeps error attribution vague).
 */
export const LEDGER_V2_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
     id TEXT PRIMARY KEY,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE ${LEDGER_TABLE} ALTER COLUMN applied_at DROP NOT NULL`,
  `ALTER TABLE ${LEDGER_TABLE}
     ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
     ADD COLUMN IF NOT EXISTS checksum_source TEXT,
     ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied',
     ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS execution_ms INTEGER,
     ADD COLUMN IF NOT EXISTS app_version TEXT,
     ADD COLUMN IF NOT EXISTS runner_version TEXT,
     ADD COLUMN IF NOT EXISTS error_class TEXT,
     ADD COLUMN IF NOT EXISTS repaired_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS repair_reason TEXT`,
  `DO $$
   BEGIN
     ALTER TABLE ${LEDGER_TABLE}
       ADD CONSTRAINT schema_migrations_status_check
       CHECK (status IN ('running', 'applied', 'dirty', 'failed'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  `DO $$
   BEGIN
     ALTER TABLE ${LEDGER_TABLE}
       ADD CONSTRAINT schema_migrations_checksum_source_check
       CHECK (checksum_source IS NULL OR checksum_source IN ('computed', 'backfilled'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
];

/** Minimal surface of a `pg` client this module needs — keeps it testable. */
export interface LedgerClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface LedgerShape {
  readonly present: boolean;
  readonly version: 1 | 2 | null;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * READ-ONLY probe of the ledger's shape. `plan`, `status`, doctor and readiness
 * all go through this: they must never create or alter anything, and they must
 * tolerate a database where migrations have never run.
 */
export async function describeLedger(client: LedgerClient): Promise<LedgerShape> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [LEDGER_TABLE],
  );
  if (res.rows.length === 0) return { present: false, version: null };
  const columns = new Set(res.rows.map((r) => r.column_name));
  const isV2 = LEDGER_V2_COLUMNS.every((c) => columns.has(c));
  return { present: true, version: isV2 ? 2 : 1 };
}

/** Create/extend the ledger to v2. The only write `up` performs before locking. */
export async function ensureLedgerSchema(client: LedgerClient): Promise<void> {
  for (const stmt of LEDGER_V2_DDL) {
    await client.query(stmt);
  }
}

/**
 * Read every ledger row, normalised to `LedgerEntry`.
 *
 * On a v1 ledger the missing columns are synthesised: a v1 row means "this file
 * was applied", with no checksum — which downstream classifies as
 * `checksum_unknown` (blocking) rather than as verified.
 */
export async function readLedger(
  client: LedgerClient,
  shape: LedgerShape,
): Promise<LedgerEntry[]> {
  if (!shape.present) return [];
  if (shape.version === 1) {
    const res = await client.query<{ id: string; applied_at: unknown }>(
      `SELECT id, applied_at FROM ${LEDGER_TABLE}`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      checksum_sha256: null,
      checksum_source: null,
      status: 'applied' as LedgerStatus,
      started_at: null,
      applied_at: toIso(r.applied_at),
      execution_ms: null,
      app_version: null,
      runner_version: null,
      error_class: null,
      repaired_at: null,
      repair_reason: null,
    }));
  }

  const res = await client.query<Record<string, unknown>>(
    `SELECT id, checksum_sha256, checksum_source, status, started_at, applied_at,
            execution_ms, app_version, runner_version, error_class, repaired_at, repair_reason
       FROM ${LEDGER_TABLE}`,
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    checksum_sha256: r.checksum_sha256 === null ? null : String(r.checksum_sha256),
    checksum_source: (r.checksum_source ?? null) as ChecksumSource | null,
    status: (r.status ?? 'applied') as LedgerStatus,
    started_at: toIso(r.started_at),
    applied_at: toIso(r.applied_at),
    execution_ms: toNumber(r.execution_ms),
    app_version: r.app_version === null ? null : String(r.app_version),
    runner_version: r.runner_version === null ? null : String(r.runner_version),
    error_class: r.error_class === null ? null : String(r.error_class),
    repaired_at: toIso(r.repaired_at),
    repair_reason: r.repair_reason === null ? null : String(r.repair_reason),
  }));
}

export interface RunProvenance {
  readonly appVersion: string | null;
  readonly runnerVersion: string;
}

/** Mark a migration as in flight. Committed BEFORE the first no-tx statement. */
export async function markRunning(
  client: LedgerClient,
  id: string,
  checksum: string,
  provenance: RunProvenance,
): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (id, status, checksum_sha256, checksum_source, started_at, applied_at, app_version, runner_version, error_class)
     VALUES ($1, 'running', $2, 'computed', now(), NULL, $3, $4, NULL)
     ON CONFLICT (id) DO UPDATE SET
       status = 'running',
       checksum_sha256 = EXCLUDED.checksum_sha256,
       checksum_source = 'computed',
       started_at = now(),
       applied_at = NULL,
       app_version = EXCLUDED.app_version,
       runner_version = EXCLUDED.runner_version,
       error_class = NULL`,
    [id, checksum, provenance.appVersion, provenance.runnerVersion],
  );
}

/** Mark a migration applied. On the transactional path this runs INSIDE the tx. */
export async function markApplied(
  client: LedgerClient,
  id: string,
  checksum: string,
  executionMs: number,
  provenance: RunProvenance,
): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (id, status, checksum_sha256, checksum_source, started_at, applied_at, execution_ms, app_version, runner_version, error_class)
     VALUES ($1, 'applied', $2, 'computed', now(), now(), $3, $4, $5, NULL)
     ON CONFLICT (id) DO UPDATE SET
       status = 'applied',
       checksum_sha256 = EXCLUDED.checksum_sha256,
       checksum_source = 'computed',
       applied_at = now(),
       execution_ms = EXCLUDED.execution_ms,
       app_version = EXCLUDED.app_version,
       runner_version = EXCLUDED.runner_version,
       error_class = NULL`,
    [id, checksum, executionMs, provenance.appVersion, provenance.runnerVersion],
  );
}

/**
 * Record a terminal failure.
 *
 * `dirty` for the no-transaction path (the schema may be partially changed);
 * `failed` for the transactional path (the rollback left nothing behind, so the
 * migration is simply retryable).
 *
 * The `WHERE status <> 'applied'` guard is not cosmetic: on the transactional
 * path the ledger insert is inside the same transaction as the DDL, so a
 * connection error raised while awaiting `COMMIT` can surface as a failure for
 * a transaction that actually committed. Without the guard, the error handler
 * would then DOWNGRADE a correctly-applied row to `failed` and the next run
 * would try to apply it again.
 */
export async function markTerminalFailure(
  client: LedgerClient,
  id: string,
  status: Extract<LedgerStatus, 'dirty' | 'failed'>,
  checksum: string,
  errorClass: string,
  provenance: RunProvenance,
): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}
       (id, status, checksum_sha256, checksum_source, started_at, applied_at, app_version, runner_version, error_class)
     VALUES ($1, $2, $3, 'computed', now(), NULL, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       applied_at = NULL,
       app_version = EXCLUDED.app_version,
       runner_version = EXCLUDED.runner_version,
       error_class = EXCLUDED.error_class
     WHERE ${LEDGER_TABLE}.status <> 'applied'`,
    [id, status, checksum, provenance.appVersion, provenance.runnerVersion, errorClass],
  );
}

/**
 * Promote every `running` row to `dirty`.
 *
 * Only ever called while HOLDING the exclusive migration lock. Under the lock
 * no other migrator can exist, so a `running` row cannot be someone's work in
 * progress — it is the debris of a process that died between "I started this
 * migration" and "it finished". Fail-closed: it becomes dirty, which blocks
 * everything until an operator inspects and repairs.
 */
export async function promoteOrphanedRunning(client: LedgerClient): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `UPDATE ${LEDGER_TABLE}
        SET status = 'dirty', error_class = COALESCE(error_class, 'orphaned_running')
      WHERE status = 'running'
      RETURNING id`,
  );
  return res.rows.map((r) => r.id);
}

/**
 * Adopt the packaged checksum for applied rows that have none — the ONE-TIME
 * bridge for migrations merged before checksums existed (issue §2: "executar
 * uma etapa única de backfill dos checksums a partir do artefato versionado;
 * marcar que o checksum foi `backfilled`").
 *
 * This is the only operation that writes a checksum it did not compute at apply
 * time, and it is why `checksum_source` exists: a `backfilled` row means "we
 * adopted whatever the artifact said at adoption time", which is trust, not
 * verification. After adoption any divergence is a hard blocker.
 *
 * Rows whose file is NOT in the artifact are deliberately left alone: there is
 * nothing trustworthy to adopt, and they stay `missing_file` (blocking).
 *
 * NEVER called from a read-only path. `plan`/`status`/readiness report
 * `checksum_unknown` instead — a read-only probe must not mutate the evidence
 * it is reporting on.
 */
export async function backfillChecksums(
  client: LedgerClient,
  artifact: MigrationArtifact,
): Promise<string[]> {
  const ids: string[] = [];
  const checksums: string[] = [];
  for (const migration of artifact.migrations) {
    ids.push(migration.id);
    checksums.push(migration.checksum);
  }
  if (ids.length === 0) return [];
  const res = await client.query<{ id: string }>(
    `UPDATE ${LEDGER_TABLE} AS m
        SET checksum_sha256 = v.checksum, checksum_source = 'backfilled'
       FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS checksum) AS v
      WHERE m.id = v.id AND m.status = 'applied' AND m.checksum_sha256 IS NULL
      RETURNING m.id`,
    [ids, checksums],
  );
  return res.rows.map((r) => r.id);
}

export type RepairOutcome = 'applied' | 'pending';

/**
 * Explicit, auditable repair of a dirty/failed row.
 *
 * `applied` — the operator verified the schema change IS in place; the row is
 * closed with the packaged checksum, marked `backfilled` (it was adopted, not
 * computed at apply time), and stamped with the reason.
 * `pending` — the operator undid the partial change; the row is deleted so the
 * migration is applied again from scratch.
 *
 * Never automatic. Never applied to a healthy row: the guard refuses anything
 * that is not currently `dirty`/`failed`/`running`, so a repair cannot quietly
 * rewrite a verified history.
 */
export async function repairEntry(
  client: LedgerClient,
  id: string,
  outcome: RepairOutcome,
  reason: string,
  checksum: string | null,
  provenance: RunProvenance,
): Promise<boolean> {
  if (outcome === 'pending') {
    const res = await client.query<{ id: string }>(
      `DELETE FROM ${LEDGER_TABLE}
        WHERE id = $1 AND status IN ('dirty', 'failed', 'running')
        RETURNING id`,
      [id],
    );
    return res.rows.length > 0;
  }
  const res = await client.query<{ id: string }>(
    `UPDATE ${LEDGER_TABLE}
        SET status = 'applied',
            checksum_sha256 = COALESCE($2::text, checksum_sha256),
            checksum_source = 'backfilled',
            applied_at = COALESCE(applied_at, now()),
            repaired_at = now(),
            repair_reason = $3,
            runner_version = $4
      WHERE id = $1 AND status IN ('dirty', 'failed', 'running')
      RETURNING id`,
    [id, checksum, reason, provenance.runnerVersion],
  );
  return res.rows.length > 0;
}
