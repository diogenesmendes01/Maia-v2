/**
 * Issue #516 §1/§5/§8 — the shared migration runner.
 *
 * This is a LIBRARY, not a script. It never calls `process.exit()`, never
 * writes to stdout, and always closes what it opened (`finally` on both the
 * success and the failure path). The CLI in `scripts/migrate.ts` is a thin
 * adapter that maps the typed result to an exit code; the init job, the tests
 * and `maia doctor` (#517) consume the same functions.
 *
 * ### Execution shape
 *
 * ```
 * acquire global advisory lock (dedicated client — src/migrations/lock.ts)
 *   └─ ensure ledger v2 schema
 *   └─ promote orphaned `running` rows to `dirty`   (crash recovery)
 *   └─ backfill checksums for pre-checksum rows     (one-time adoption)
 *   └─ compute status  (pure; src/migrations/status.ts)
 *   └─ REFUSE if anything blocks   ← fail-closed, before touching the schema
 *   └─ apply pending, in artifact order, stopping at the first failure
 * release lock (finally)
 * ```
 *
 * ### Three transaction modes, because only one of them can be atomic
 *
 * **`runner`** — the file has no transaction control of its own (110 of the 122
 * migrations on disk today). `BEGIN` → migration SQL → ledger row → `COMMIT`.
 * The ledger row is written inside the same transaction, so "applied" and
 * "recorded" really are atomic: a crash leaves neither. A clean SQL error rolls
 * back and is recorded as `failed` — retryable, nothing was left behind.
 *
 * **`self`** — the file contains its own `BEGIN; … COMMIT;`. The pre-#516
 * runner wrapped these too and believed the result was atomic; it was not.
 * Postgres does not nest transactions, so the file's `COMMIT` closes the
 * runner's envelope, the ledger `INSERT` that follows executes in autocommit,
 * and the runner's trailing `COMMIT` warns "no transaction in progress". A
 * crash in that gap left the schema changed and the ledger silent, so the
 * migration re-ran on the next boot. Atomicity is not recoverable here, so the
 * runner stops pretending and uses the `running`-first protocol below, which
 * turns the silent gap into a visible dirty state.
 *
 * `BEGIN;` alone does not make such a file atomic either, so discovery PROVES
 * the shape: a `self` migration must be ONE complete `BEGIN; … COMMIT;` around
 * all of its executable SQL. `BEGIN; … COMMIT; <one more statement>` commits
 * the first part durably before the last one can fail, and is refused as an
 * artifact problem before any DDL runs (`analyzeTransactionEnvelope` in
 * `discover.ts`; `terminalLedgerStatusFor` below is the matching fail-closed
 * classification).
 *
 * **`none`** — `-- maia:no-transaction` (e.g. `CREATE INDEX CONCURRENTLY`,
 * which Postgres refuses inside `BEGIN`). Same protocol, statements sent one at
 * a time (node-postgres wraps a multi-statement `query()` in an implicit
 * transaction, which CONCURRENTLY also rejects).
 *
 * The `running`-first protocol shared by `self` and `none`:
 *   1. commit a `running` row BEFORE the first statement,
 *   2. run the migration,
 *   3. on success flip the row to `applied`; on a clean error flip it to
 *      `failed` (a `self` file whose single envelope really did roll back) or
 *      `dirty` (`none`, and anything else that cannot prove a rollback).
 * If the process DIES at step 2 the row stays `running`, and the next run —
 * which holds the exclusive lock, so it knows no migrator is alive — promotes
 * it to `dirty`. A dirty migration is NEVER auto-retried and NEVER treated as
 * success; it blocks every subsequent migration until an operator inspects the
 * schema and repairs the row explicitly.
 */
import { discoverMigrations, splitNoTxStatements } from './discover.js';
import {
  backfillChecksums,
  ensureLedgerSchema,
  markApplied,
  markRunning,
  markTerminalFailure,
  promoteOrphanedRunning,
  readLedger,
  repairEntry,
  type LedgerClient,
  type RepairOutcome,
  type RunProvenance,
} from './ledger.js';
import { acquireMigrationLock, type LockDeps, type LockOptions } from './lock.js';
import { computeMigrationStatus } from './status.js';
import { shortChecksum } from './checksum.js';
import type {
  DiscoveredMigration,
  MigrationArtifact,
  MigrationStatusReport,
  SchemaBlocker,
} from './types.js';

/** Bumped when the runner's ledger semantics change. Stamped on every row. */
export const RUNNER_VERSION = '2.0.0';

/**
 * Default `lock_timeout` for migration statements. Guards the classic outage:
 * a migration's `ALTER TABLE` queues behind a long-running query, and every
 * subsequent query queues behind the migration's lock request. Failing after
 * 10s is recoverable; blocking the whole table for minutes is not.
 */
export const DEFAULT_STATEMENT_LOCK_TIMEOUT_MS = 10_000;

export type MigrationEvent =
  | 'migration.lock_wait'
  | 'migration.lock_acquired'
  | 'migration.lock_unavailable'
  | 'migration.lock_release_failed'
  | 'migration.started'
  | 'migration.applied'
  | 'migration.failed'
  | 'migration.dirty'
  | 'migration.checksum_mismatch'
  | 'migration.checksum_backfilled'
  | 'migration.blocked'
  | 'migration.repaired';

/**
 * Structured, redaction-safe event sink. Callers get IDs, short checksums,
 * durations and error CLASSES — never SQL text, never driver messages (which
 * embed the DSN, password included) and never `DATABASE_URL`.
 */
export type MigrationEventSink = (event: string, detail: Record<string, unknown>) => void;

export interface RunnerPoolClient extends LedgerClient {
  release(): void;
}

export interface RunnerPool {
  connect(): Promise<RunnerPoolClient>;
}

export interface RunnerDeps {
  readonly pool: RunnerPool;
  readonly migrationsDir: string;
  readonly onEvent?: MigrationEventSink;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stamped on ledger rows for provenance. */
  readonly appVersion?: string | null;
}

export interface RunOptions extends LockOptions {
  /** Per-statement lock ceiling. `null` disables (Postgres default). */
  readonly lockTimeoutMs?: number | null;
  /**
   * Per-statement execution ceiling. Default `null` (no ceiling): a legitimate
   * data backfill runs for minutes, and killing a NO-TRANSACTION migration
   * midway manufactures exactly the dirty state this feature exists to avoid.
   * Set it per environment, or per migration via `-- maia:statement-timeout=`.
   */
  readonly statementTimeoutMs?: number | null;
}

export type RunOutcome =
  | 'applied'
  | 'up_to_date'
  | 'blocked'
  | 'lock_unavailable'
  | 'failed';

export interface MigrationRunResult {
  readonly ok: boolean;
  readonly outcome: RunOutcome;
  /** Ids applied in THIS run, in order. */
  readonly applied: readonly string[];
  /** Ids whose checksum was adopted from the artifact in this run. */
  readonly backfilled: readonly string[];
  /** Ids promoted from a crashed `running` to `dirty` in this run. */
  readonly orphaned: readonly string[];
  readonly blockers: readonly SchemaBlocker[];
  readonly status: MigrationStatusReport | null;
  readonly failure?: {
    readonly id: string;
    readonly error_class: string;
    readonly ledger_status: 'dirty' | 'failed';
  };
  readonly lock_waited_ms: number;
}

/**
 * The ledger status a terminal failure gets: `failed` (retryable — nothing was
 * left behind) or `dirty` (a partial change may be durable — never auto-retried).
 *
 * The rule is "record `failed` only where a rollback is PROVEN", not "record
 * `failed` unless the file is no-transaction". The difference is the #541
 * finding: the old test `transactionMode === 'none' ? 'dirty' : 'failed'` read
 * a `self` file's `BEGIN;` as proof of atomicity, but `BEGIN; … COMMIT; <more>`
 * carries the same `BEGIN;` and none of the guarantee — the earlier DDL is
 * already durable, the runner's ROLLBACK is a no-op, and `failed` would put
 * that half-applied schema straight back into the auto-retry queue.
 *
 * So the proof is now the ENVELOPE, computed at discovery
 * (`analyzeTransactionEnvelope`), and anything unproven fails CLOSED to `dirty`
 * (AGENTS.md §4 rule 2). Such a file is also refused as an artifact problem
 * before any DDL runs, so in practice this branch is the second line of
 * defence — it is what keeps the classification honest for any future caller
 * that reaches the runner with an artifact whose problems it chose to ignore.
 */
export function terminalLedgerStatusFor(
  migration: Pick<DiscoveredMigration, 'transactionMode' | 'transactionEnvelope'>,
): 'dirty' | 'failed' {
  switch (migration.transactionMode) {
    // The runner's own BEGIN/COMMIT wraps the DDL and the ledger row together.
    case 'runner':
      return 'failed';
    // Proven atomic only when the file is ONE complete envelope.
    case 'self':
      return migration.transactionEnvelope === 'single_complete' ? 'failed' : 'dirty';
    // No transaction at all: a partial change is the expected failure mode.
    case 'none':
      return 'dirty';
  }
}

function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error) return err.constructor.name;
  return 'UnknownError';
}

/**
 * Re-read the ledger and recompute `status` from it.
 *
 * `MigrationStatusReport` is contracted as the COMPLETE description of artifact
 * × database, so it may never be a snapshot taken at some earlier point of the
 * run. It is recomputed at every return that follows a ledger write — including
 * the failure return, which is the #541 finding: reusing the pre-loop snapshot
 * there produced a result whose `failure.ledger_status` said `dirty` while
 * `status.entries` still classified the very same migration as `pending`, and
 * which listed migrations this run had just applied as still pending. `maia
 * doctor` and any automation reading `status` would remediate the wrong thing.
 *
 * `lockHeld: true` is correct for every caller here: we hold the exclusive
 * advisory lock, so a `running` row can only be crash debris. In particular, if
 * `markTerminalFailure` itself failed, the row stays `running` and the
 * recomputed report says `orphaned_running` — which is exactly what it is.
 */
async function readStatus(
  client: LedgerClient,
  artifact: MigrationArtifact,
): Promise<MigrationStatusReport> {
  const ledger = await readLedger(client, { present: true, version: 2 });
  return computeMigrationStatus(artifact, ledger, {
    ledgerPresent: true,
    ledgerVersion: 2,
    lockHeld: true,
  });
}

async function applyTimeouts(
  client: LedgerClient,
  lockTimeoutMs: number | null,
  statementTimeoutMs: number | null,
): Promise<void> {
  // Numeric interpolation only — both values are validated numbers, and
  // Postgres does not accept a bind parameter in SET.
  await client.query(`SET lock_timeout = ${lockTimeoutMs === null ? 0 : Math.trunc(lockTimeoutMs)}`);
  await client.query(
    `SET statement_timeout = ${statementTimeoutMs === null ? 0 : Math.trunc(statementTimeoutMs)}`,
  );
}

/**
 * Apply every pending migration under the global lock.
 *
 * Returns a typed result for EVERY outcome, including "someone else holds the
 * lock" and "the schema is blocked" — the caller decides what that means for
 * the process. Nothing here throws for an expected condition.
 */
export async function runMigrations(
  deps: RunnerDeps,
  options: RunOptions = {},
): Promise<MigrationRunResult> {
  const emit = deps.onEvent ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const provenance: RunProvenance = {
    appVersion: deps.appVersion ?? null,
    runnerVersion: RUNNER_VERSION,
  };
  const lockDeps: LockDeps = {
    pool: deps.pool,
    onEvent: emit,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };

  const acquisition = await acquireMigrationLock(lockDeps, options);
  if (!acquisition.acquired) {
    emit('migration.lock_unavailable', {
      reason: acquisition.reason,
      waited_ms: acquisition.waited_ms,
      ...(acquisition.error_class ? { error_class: acquisition.error_class } : {}),
    });
    return {
      ok: false,
      outcome: 'lock_unavailable',
      applied: [],
      backfilled: [],
      orphaned: [],
      blockers: [
        {
          kind: 'ledger_unavailable',
          detail: `could not acquire the global migration lock (${acquisition.reason}) — refusing to migrate without proving this is the only migrator`,
        },
      ],
      status: null,
      lock_waited_ms: acquisition.waited_ms,
    };
  }

  const client = acquisition.lock.client as RunnerPoolClient;
  const lockWaited = acquisition.waited_ms;
  try {
    return await applyUnderLock(client, deps, options, provenance, emit, now, lockWaited);
  } finally {
    await acquisition.lock.release();
  }
}

async function applyUnderLock(
  client: RunnerPoolClient,
  deps: RunnerDeps,
  options: RunOptions,
  provenance: RunProvenance,
  emit: MigrationEventSink,
  now: () => number,
  lockWaited: number,
): Promise<MigrationRunResult> {
  const artifact = await discoverMigrations(deps.migrationsDir);

  await applyTimeouts(
    client,
    options.lockTimeoutMs === undefined ? DEFAULT_STATEMENT_LOCK_TIMEOUT_MS : options.lockTimeoutMs,
    options.statementTimeoutMs ?? null,
  );
  await ensureLedgerSchema(client);

  // Crash recovery, done under the lock so `running` is unambiguous.
  const orphaned = await promoteOrphanedRunning(client);
  for (const id of orphaned) {
    emit('migration.dirty', { migration_id: id, cause: 'orphaned_running' });
  }

  // One-time checksum adoption for rows written before checksums existed.
  const backfilled = await backfillChecksums(client, artifact);
  for (const id of backfilled) {
    emit('migration.checksum_backfilled', {
      migration_id: id,
      checksum: shortChecksum(artifact.byId.get(id)?.checksum ?? null),
    });
  }

  const status = await readStatus(client, artifact);

  const blockers: SchemaBlocker[] = [];
  for (const entry of status.entries) {
    if (!entry.blocking) continue;
    if (entry.state === 'checksum_mismatch') {
      emit('migration.checksum_mismatch', {
        migration_id: entry.id,
        ledger_checksum: shortChecksum(entry.ledger_checksum),
        artifact_checksum: shortChecksum(entry.checksum),
      });
    }
    blockers.push({
      kind:
        entry.state === 'checksum_mismatch'
          ? 'checksum_mismatch'
          : entry.state === 'missing_file'
            ? 'missing_file'
            : entry.state === 'checksum_unknown'
              ? 'checksum_unknown'
              : entry.state === 'orphaned_running'
                ? 'orphaned_running'
                : 'dirty_migration',
      id: entry.id,
      detail: `migration "${entry.id}" is ${entry.state} — refusing to apply anything on top of an unverified schema`,
    });
  }
  // Repository integrity: a forward migration with no `_down` sibling violates
  // AGENTS.md §4 rule 6 and must not reach a database.
  for (const problem of artifact.problems) {
    blockers.push({ kind: 'artifact_integrity', id: problem.id, detail: problem.detail });
  }

  if (blockers.length > 0) {
    emit('migration.blocked', {
      blockers: blockers.length,
      first_kind: blockers[0]!.kind,
      first_migration_id: blockers[0]!.id ?? null,
    });
    return {
      ok: false,
      outcome: 'blocked',
      applied: [],
      backfilled,
      orphaned,
      blockers,
      status,
      lock_waited_ms: lockWaited,
    };
  }

  if (status.pending.length === 0) {
    return {
      ok: true,
      outcome: 'up_to_date',
      applied: [],
      backfilled,
      orphaned,
      blockers: [],
      status,
      lock_waited_ms: lockWaited,
    };
  }

  const applied: string[] = [];
  for (const id of status.pending) {
    const migration = artifact.byId.get(id)!;
    const startedAt = now();
    emit('migration.started', {
      migration_id: id,
      checksum: shortChecksum(migration.checksum),
      transaction_mode: migration.transactionMode,
    });

    if (migration.statementTimeoutMs !== null) {
      await client.query(`SET statement_timeout = ${Math.trunc(migration.statementTimeoutMs)}`);
    }

    try {
      switch (migration.transactionMode) {
        case 'runner':
          // Genuinely atomic: the DDL and the ledger row commit together, so a
          // crash anywhere in here leaves the migration simply pending.
          await client.query('BEGIN');
          try {
            await client.query(migration.sql);
            await markApplied(client, id, migration.checksum, now() - startedAt, provenance);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
          break;

        case 'self':
          // The file owns its transaction, so the ledger row CANNOT join it.
          // Commit `running` first: a crash then leaves a visible in-flight row
          // that the next run turns into `dirty`, instead of a silent gap where
          // the schema moved and the ledger did not.
          await markRunning(client, id, migration.checksum, provenance);
          try {
            await client.query(migration.sql);
          } catch (err) {
            // A failure inside the file's own BEGIN leaves the session in an
            // aborted transaction; clear it before touching the ledger.
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
          await markApplied(client, id, migration.checksum, now() - startedAt, provenance);
          break;

        case 'none':
          await markRunning(client, id, migration.checksum, provenance);
          for (const stmt of splitNoTxStatements(migration.sql)) {
            await client.query(stmt);
          }
          await markApplied(client, id, migration.checksum, now() - startedAt, provenance);
          break;
      }
    } catch (err) {
      const cls = errorClass(err);
      // `dirty` only where a partial change is actually possible — decided from
      // the file's PROVEN transaction envelope, not from its `BEGIN;`. See
      // `terminalLedgerStatusFor`.
      const ledgerStatus = terminalLedgerStatusFor(migration);
      await markTerminalFailure(
        client,
        id,
        ledgerStatus,
        migration.checksum,
        cls,
        provenance,
      ).catch(() => undefined);
      emit(ledgerStatus === 'dirty' ? 'migration.dirty' : 'migration.failed', {
        migration_id: id,
        checksum: shortChecksum(migration.checksum),
        duration_ms: now() - startedAt,
        error_class: cls,
        transaction_mode: migration.transactionMode,
      });
      // The ledger moved twice since `status` was computed — every migration
      // applied above, plus the row just written for this failure — so the
      // snapshot is re-read rather than reused. If the re-read itself fails
      // (a dead connection is a plausible cause of the failure we are already
      // reporting), `status` is `null`: the documented "could not be
      // established" value, never a stale report presented as current.
      const failureStatus = await readStatus(client, artifact).catch(() => null);
      return {
        ok: false,
        outcome: 'failed',
        applied,
        backfilled,
        orphaned,
        blockers: [
          {
            kind: ledgerStatus === 'dirty' ? 'dirty_migration' : 'migration_failed',
            id,
            detail: `migration "${id}" failed (${cls}); recorded as ${ledgerStatus}. Subsequent migrations were NOT attempted.`,
          },
        ],
        status: failureStatus,
        failure: { id, error_class: cls, ledger_status: ledgerStatus },
        lock_waited_ms: lockWaited,
      };
    } finally {
      if (migration.statementTimeoutMs !== null) {
        await applyTimeouts(
          client,
          options.lockTimeoutMs === undefined
            ? DEFAULT_STATEMENT_LOCK_TIMEOUT_MS
            : options.lockTimeoutMs,
          options.statementTimeoutMs ?? null,
        ).catch(() => undefined);
      }
    }

    applied.push(id);
    emit('migration.applied', {
      migration_id: id,
      checksum: shortChecksum(migration.checksum),
      duration_ms: now() - startedAt,
      transaction_mode: migration.transactionMode,
    });
  }

  return {
    ok: true,
    outcome: 'applied',
    applied,
    backfilled,
    orphaned,
    blockers: [],
    status: await readStatus(client, artifact),
    lock_waited_ms: lockWaited,
  };
}

export interface RepairRequest {
  readonly id: string;
  readonly outcome: RepairOutcome;
  readonly reason: string;
}

export type RepairResult =
  | { readonly ok: true; readonly id: string; readonly outcome: RepairOutcome }
  | { readonly ok: false; readonly reason: string };

/**
 * Why `--as applied` cannot be honoured for a given id.
 *
 * - `artifact_missing`  — this build does not package the file at all, so
 *   there is nothing to hash and the row would stay `missing_file`.
 * - `checksum_missing`  — the file is packaged but carries no digest, so the
 *   row would stay `checksum_unknown`.
 *
 * Both leave `status`/`up` blocked on exactly the same id the operator was
 * just told had been repaired.
 */
export type RepairRefusalRule = 'artifact_missing' | 'checksum_missing';

/**
 * The refusal text for `--as applied` without a verifiable artifact.
 *
 * Shaped like `ConfigValidationError` (`src/config/load.ts:59`), which is the
 * repo's model for actionable diagnosis: one line naming WHAT is missing,
 * indented `→` lines naming what to do instead. Exported so the CLI, the tests
 * and the runbook all quote one string rather than three that drift.
 */
export function repairAppliedRefusal(id: string, rule: RepairRefusalRule): string {
  const missing =
    rule === 'artifact_missing'
      ? `this build does not package migrations/${id}, so there is no checksum to record and the row would stay missing_file`
      : `migrations/${id} is packaged but has no checksum, so the row would stay checksum_unknown`;
  const nextState = rule === 'artifact_missing' ? 'missing_file' : 'checksum_unknown';
  return (
    `repair --as applied refused for "${id}": it would report success without repairing readiness.\n` +
    `  - ${id} [repair/${rule}]: ${missing}.\n` +
    `      → Marking it applied here writes checksum_source='backfilled' with nothing verified, ` +
    `and the next \`migrate status\`/\`migrate up\` blocks again on ${nextState} — repaired in name only.\n` +
    `      → Run the repair from a build that ships ${id}, so the packaged checksum can be adopted.\n` +
    `      → Or, if ${id} must not stand in this schema: undo its effects by hand, then ` +
    `\`migrate repair --id ${id} --as pending --reason "<why>"\` — that DELETES the ledger row ` +
    `so the migration is applied again from scratch, instead of certifying a schema nobody can verify.`
  );
}

/**
 * Explicit repair of a dirty/failed/orphaned ledger row.
 *
 * Deliberately NOT part of `up`: "clearing the flag" is exactly what the
 * runbook forbids doing reflexively. It takes the same global lock (so it
 * cannot race a migrator), demands a non-empty reason that is persisted on the
 * row, and refuses to touch a healthy `applied` row.
 *
 * ### Why `--as applied` demands the packaged file AND its checksum
 *
 * `repairEntry` writes `checksum_sha256 = COALESCE($2, checksum_sha256)`, so a
 * NULL checksum still flipped the row to `applied` and stamped
 * `checksum_source = 'backfilled'` — and this function still returned success.
 * The very next `status`/`up` then blocked again on `missing_file` /
 * `checksum_unknown` for that same id. The operator was told "repaired" while
 * readiness had not moved, in the one tool they reach for during an incident.
 *
 * So the artifact is checked FIRST — before the lock, before any DDL, so a
 * refusal costs nothing and contends with no migrator — and `pending` stays the
 * explicit remediation for the case where there is nothing to verify.
 */
export async function repairMigration(
  deps: RunnerDeps,
  request: RepairRequest,
  options: LockOptions = {},
): Promise<RepairResult> {
  const emit = deps.onEvent ?? (() => undefined);
  if (request.reason.trim().length === 0) {
    return { ok: false, reason: 'a repair requires a non-empty --reason; it is persisted on the ledger row as the audit trail' };
  }
  const artifact = await discoverMigrations(deps.migrationsDir);
  const packaged = artifact.byId.get(request.id) ?? null;
  const checksum = packaged?.checksum ?? null;
  if (request.outcome === 'applied') {
    const rule: RepairRefusalRule | null =
      packaged === null
        ? 'artifact_missing'
        : checksum === null || checksum.length === 0
          ? 'checksum_missing'
          : null;
    if (rule !== null) {
      return { ok: false, reason: repairAppliedRefusal(request.id, rule) };
    }
  }
  const acquisition = await acquireMigrationLock(
    { pool: deps.pool, onEvent: emit, ...(deps.now ? { now: deps.now } : {}) },
    options,
  );
  if (!acquisition.acquired) {
    return { ok: false, reason: `could not acquire the global migration lock (${acquisition.reason})` };
  }
  const client = acquisition.lock.client as RunnerPoolClient;
  try {
    await ensureLedgerSchema(client);
    const changed = await repairEntry(
      client,
      request.id,
      request.outcome,
      request.reason.trim(),
      checksum,
      { appVersion: deps.appVersion ?? null, runnerVersion: RUNNER_VERSION },
    );
    if (!changed) {
      return {
        ok: false,
        reason: `"${request.id}" is not in a repairable state (only dirty/failed/running rows can be repaired) or does not exist`,
      };
    }
    emit('migration.repaired', {
      migration_id: request.id,
      repaired_to: request.outcome,
      reason: request.reason.trim(),
    });
    return { ok: true, id: request.id, outcome: request.outcome };
  } finally {
    await acquisition.lock.release();
  }
}
