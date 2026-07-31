/**
 * The migration runner (issue #516 §1, §5, §8).
 *
 * Shared library, used by BOTH the CLI (`maia migrate …`) and the one-shot
 * deploy job — there is exactly one implementation of "apply the forward
 * chain" in this repo, so the schema a test builds and the schema production
 * gets cannot drift.
 *
 * Contract highlights:
 *   - `plan` and `status` are READ-ONLY: no DDL, no lock, no ledger writes.
 *     They must stay usable while a migration is in flight, which is exactly
 *     when an operator needs them.
 *   - `up` holds the global advisory lock for the WHOLE run on a dedicated
 *     client, refuses to start when the ledger shows drift, and stops at the
 *     first failure.
 *   - the core NEVER calls `process.exit()` and never closes a pool it did not
 *     open. Exit codes are the CLI's job.
 */
import type { Pool, PoolClient } from 'pg';
import {
  discoverMigrations,
  defaultMigrationsDir,
  shortChecksum,
  splitNoTxStatements,
} from './discover.js';
import { readFileSync } from 'node:fs';
import { evaluateCompatibility } from './compatibility.js';
import {
  applyRepair,
  backfillChecksums,
  clearRow,
  ensureLedger,
  errorClassOf,
  markApplied,
  markRunning,
  markTerminal,
  readLedger,
  recordEvent,
  type RunnerContext,
} from './ledger.js';
import { withMigrationLock } from './lock.js';
import { migrationLogger, type MigrationLogger } from './log.js';
import {
  BLOCKS_UP,
  MIGRATION_RUNNER_VERSION,
  type AppliedMigration,
  type DiscoveredMigration,
  type Drift,
  type LedgerRow,
  type MigrateUpResult,
  type SchemaCompatibility,
} from './types.js';

/** Default budget for taking the advisory lock. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** Default per-statement budget inside a migration. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;

export interface RunnerOptions {
  /** Caller owns the pool's lifecycle — the runner never ends it. */
  readonly pool: Pool;
  readonly migrationsDir?: string;
  readonly logger?: MigrationLogger;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** Build identity written into the ledger (`MAIA_BUILD_COMMIT`). */
  readonly appVersion?: string | null;
  readonly minSupported?: string | null;
  readonly maxSupported?: string | null;
}

export type MigrationState = 'applied' | 'pending' | 'dirty' | 'failed' | 'running';

export interface MigrationPlanEntry {
  readonly id: string;
  readonly checksum_short: string;
  readonly no_transaction: boolean;
  readonly idempotent: boolean;
  readonly has_down: boolean;
  readonly state: MigrationState;
}

/** Read-only snapshot: what the build ships vs. what the database applied. */
export interface MigrationPlan {
  readonly runner_version: string;
  /** `false` on a virgin database (no `schema_migrations` table yet). */
  readonly ledger_exists: boolean;
  readonly compatibility: SchemaCompatibility;
  readonly migrations: readonly MigrationPlanEntry[];
}

function stateOf(row: LedgerRow | undefined): MigrationState {
  if (!row) return 'pending';
  return row.status;
}

function contextOf(options: RunnerOptions): RunnerContext {
  return { appVersion: options.appVersion ?? null };
}

function migrationsOf(options: RunnerOptions): DiscoveredMigration[] {
  return discoverMigrations(options.migrationsDir ?? defaultMigrationsDir());
}

function compatOf(
  options: RunnerOptions,
  migrations: readonly DiscoveredMigration[],
  rows: readonly LedgerRow[],
): SchemaCompatibility {
  return evaluateCompatibility({
    migrations,
    rows,
    minSupported: options.minSupported ?? null,
    maxSupported: options.maxSupported ?? null,
  });
}

/**
 * READ-ONLY plan/status. Takes no lock and issues no DDL, so it stays
 * answerable while another migrator holds the lock — which is precisely when
 * an operator is trying to find out what is going on.
 */
export async function planMigrations(options: RunnerOptions): Promise<MigrationPlan> {
  const migrations = migrationsOf(options);
  const client = await options.pool.connect();
  try {
    const snapshot = await readLedger(client);
    const byRow = new Map(snapshot.rows.map((r) => [r.id, r]));
    return {
      runner_version: MIGRATION_RUNNER_VERSION,
      ledger_exists: snapshot.exists,
      compatibility: compatOf(options, migrations, snapshot.rows),
      migrations: migrations.map((m) => ({
        id: m.id,
        checksum_short: shortChecksum(m.checksum),
        no_transaction: m.noTransaction,
        idempotent: m.idempotent,
        has_down: m.downId !== null,
        state: stateOf(byRow.get(m.id)),
      })),
    };
  } finally {
    client.release();
  }
}

/**
 * Reconcile `running` rows left behind by a crashed migrator.
 *
 * Called ONLY while holding the advisory lock, which is what makes it sound:
 * with the lock held, no other migrator can be executing, so every `running`
 * row is necessarily an orphan from a process that died.
 *
 *   - transactional  → the transaction rolled back when the backend died, so
 *                      nothing was applied. Drop the row; it is simply pending.
 *   - no-tx, `-- maia:idempotent` → the author declared re-execution safe.
 *                      Drop the row and let it run again.
 *   - no-tx, otherwise → DIRTY. The schema may be partially changed and no
 *                      amount of re-running can tell. A human has to look.
 */
async function reconcileOrphanRuns(
  client: PoolClient,
  migrations: readonly DiscoveredMigration[],
  rows: readonly LedgerRow[],
  logger: MigrationLogger,
): Promise<void> {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  for (const row of rows) {
    if (row.status !== 'running') continue;
    const file = byId.get(row.id);
    const retryable = file ? !file.noTransaction || file.idempotent : false;
    if (retryable) {
      await clearRow(client, row.id);
      await recordEvent(client, 'stale_running_reset', {
        migrationId: row.id,
        detail: { no_transaction: file?.noTransaction ?? null, idempotent: file?.idempotent ?? null },
      });
      logger.warn('migration.stale_running_reset', {
        migration_id: row.id,
        reason: 'previous run crashed; the change was transactional or declared idempotent',
      });
    } else {
      await markTerminal(client, row.id, 'dirty', 'crash_no_transaction', row.execution_ms ?? 0);
      await recordEvent(client, 'dirty', {
        migrationId: row.id,
        reason: 'running row found with the migration lock held — previous run crashed',
      });
      logger.error('migration.dirty', {
        migration_id: row.id,
        reason: 'crashed mid-flight outside a transaction; schema state is unverified',
      });
    }
  }
}

async function applyOne(
  client: PoolClient,
  migration: DiscoveredMigration,
  ctx: RunnerContext,
  statementTimeoutMs: number,
  logger: MigrationLogger,
): Promise<AppliedMigration> {
  const checksumShort = shortChecksum(migration.checksum);
  const timeoutMs = migration.statementTimeoutMs ?? statementTimeoutMs;
  logger.info('migration.started', {
    migration_id: migration.id,
    checksum: checksumShort,
    no_transaction: migration.noTransaction,
    statement_timeout_ms: timeoutMs,
  });

  const sql = readFileSync(migration.path, 'utf8');
  await markRunning(client, migration, ctx);
  // Session-level (not `SET LOCAL`) so it also covers the no-transaction path,
  // where there is no enclosing transaction to scope it to.
  await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

  const startedAt = Date.now();
  try {
    if (!migration.noTransaction) {
      // ATOMIC: the DDL and the ledger row commit together or not at all.
      await client.query('BEGIN');
      await client.query(sql);
      await markApplied(client, migration, ctx, Date.now() - startedAt);
      await client.query('COMMIT');
    } else {
      // node-postgres wraps multiple statements in ONE query() in an implicit
      // transaction, which CONCURRENTLY rejects — send each on its own.
      for (const statement of splitNoTxStatements(sql)) {
        await client.query(statement);
      }
      await markApplied(client, migration, ctx, Date.now() - startedAt);
    }
    const durationMs = Date.now() - startedAt;
    logger.info('migration.applied', {
      migration_id: migration.id,
      checksum: checksumShort,
      duration_ms: durationMs,
      no_transaction: migration.noTransaction,
    });
    return {
      id: migration.id,
      checksum_short: checksumShort,
      no_transaction: migration.noTransaction,
      duration_ms: durationMs,
      result: 'applied',
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorClass = errorClassOf(err);
    if (!migration.noTransaction) {
      await client.query('ROLLBACK').catch(() => undefined);
      await markTerminal(client, migration.id, 'failed', errorClass, durationMs);
      await recordEvent(client, 'failed', {
        migrationId: migration.id,
        detail: { error_class: errorClass, duration_ms: durationMs },
      });
      logger.error('migration.failed', {
        migration_id: migration.id,
        checksum: checksumShort,
        duration_ms: durationMs,
        error_class: errorClass,
        rolled_back: true,
      });
      return {
        id: migration.id,
        checksum_short: checksumShort,
        no_transaction: false,
        duration_ms: durationMs,
        result: 'failed',
        error_class: errorClass,
      };
    }
    // No-transaction: part of the DDL may have landed. Say so.
    await markTerminal(client, migration.id, 'dirty', errorClass, durationMs);
    await recordEvent(client, 'dirty', {
      migrationId: migration.id,
      detail: { error_class: errorClass, duration_ms: durationMs },
    });
    logger.error('migration.dirty', {
      migration_id: migration.id,
      checksum: checksumShort,
      duration_ms: durationMs,
      error_class: errorClass,
      reason: 'failed outside a transaction; schema may be partially applied',
    });
    return {
      id: migration.id,
      checksum_short: checksumShort,
      no_transaction: true,
      duration_ms: durationMs,
      result: 'dirty',
      error_class: errorClass,
    };
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => undefined);
  }
}

/**
 * Apply every pending forward migration, serialised by the global advisory
 * lock. Returns a typed result; never throws for an expected condition
 * (lock contention, drift, a failing migration) and never exits the process.
 */
export async function migrateUp(options: RunnerOptions): Promise<MigrateUpResult> {
  const logger = options.logger ?? migrationLogger;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const ctx = contextOf(options);
  const migrations = migrationsOf(options);

  // DEDICATED client: the advisory lock is session-scoped, so the same
  // connection must stay checked out for the entire run.
  const client = await options.pool.connect();
  try {
    const run = await withMigrationLock(client, lockTimeoutMs, async (waitedMs) => {
      if (waitedMs > 250) {
        logger.info('migration.lock_wait', { waited_ms: waitedMs });
        await recordEvent(client, 'lock_wait', { detail: { waited_ms: waitedMs } });
      }
      await ensureLedger(client);

      const first = await readLedger(client);
      await reconcileOrphanRuns(client, migrations, first.rows, logger);

      const beforeBackfill = await readLedger(client);
      const backfilled = await backfillChecksums(client, migrations, beforeBackfill.rows);
      if (backfilled.length > 0) {
        await recordEvent(client, 'backfill', { detail: { count: backfilled.length } });
        logger.info('migration.backfill', {
          count: backfilled.length,
          reason: 'adopted checksums for pre-v2 ledger rows from the packaged artifact',
        });
      }

      const snapshot = await readLedger(client);
      const compat = compatOf(options, migrations, snapshot.rows);
      const head = compat.applied_head;

      const blockers = compat.problems.filter((p) => BLOCKS_UP.has(p.code));
      if (blockers.length > 0) {
        for (const problem of blockers) {
          if (problem.code === 'checksum_mismatch') {
            await recordEvent(client, 'checksum_mismatch', {
              migrationId: problem.id,
              detail: { detail: problem.detail },
            });
            logger.error('migration.checksum_mismatch', {
              migration_id: problem.id,
              detail: problem.detail,
            });
          }
        }
        await recordEvent(client, 'blocked', {
          detail: { codes: blockers.map((p) => p.code) },
        });
        logger.error('migration.blocked', {
          head_applied: head,
          head_expected: compat.expected_head,
          problems: blockers.map((p) => ({ code: p.code, id: p.id, detail: p.detail })),
        });
        return {
          outcome: 'blocked' as const,
          lock_wait_ms: waitedMs,
          problems: blockers as readonly Drift[],
          head,
        };
      }

      for (const problem of compat.problems.filter((p) => p.severity === 'warn')) {
        logger.warn('migration.plan', { code: problem.code, migration_id: problem.id, detail: problem.detail });
      }

      const byId = new Map(migrations.map((m) => [m.id, m]));
      const applied: AppliedMigration[] = [];
      for (const id of compat.pending) {
        const migration = byId.get(id);
        if (!migration) continue;
        const result = await applyOne(client, migration, ctx, statementTimeoutMs, logger);
        applied.push(result);
        if (result.result !== 'applied') {
          // Everything after a failure is deliberately NOT attempted: the next
          // migration would run on a schema nobody has verified.
          return {
            outcome: 'failed' as const,
            lock_wait_ms: waitedMs,
            applied: applied as readonly AppliedMigration[],
            failed_id: result.id,
            error_class: result.error_class ?? 'UnknownError',
            dirty: result.result === 'dirty',
            head: applied.filter((a) => a.result === 'applied').at(-1)?.id ?? head,
          };
        }
      }

      const newHead = applied.length > 0 ? applied[applied.length - 1]!.id : head;
      logger.info('migration.done', {
        applied_count: applied.length,
        head: newHead,
        lock_wait_ms: waitedMs,
      });
      return {
        outcome: (applied.length > 0 ? 'applied' : 'noop') as 'applied' | 'noop',
        lock_wait_ms: waitedMs,
        applied: applied as readonly AppliedMigration[],
        head: newHead,
      };
    });

    if (run.outcome === 'timeout') {
      logger.error('migration.lock_timeout', {
        waited_ms: run.waitedMs,
        reason: 'another migrator holds the global migration lock',
      });
      return { outcome: 'lock_timeout', lock_wait_ms: run.waitedMs };
    }
    return run.value;
  } finally {
    client.release();
  }
}

export interface RepairRequest {
  readonly id: string;
  /**
   * `applied` — the operator VERIFIED the schema change is fully present.
   * `pending` — the operator VERIFIED nothing (or reverted it by hand), so the
   *             migration should run again.
   */
  readonly resolution: 'applied' | 'pending';
  readonly reason: string;
  readonly actor: string;
}

export type RepairResult =
  | { readonly outcome: 'repaired'; readonly id: string; readonly resolution: 'applied' | 'pending' }
  | { readonly outcome: 'not_found'; readonly id: string }
  | { readonly outcome: 'lock_timeout'; readonly lock_wait_ms: number };

/**
 * Explicit, audited repair of a single ledger row (issue #516 §5).
 *
 * The EXCEPTIONAL path, and deliberately awkward: it demands an actor and a
 * reason, both of which land in the append-only `schema_migration_events`
 * trail. "Clearing the flag" without inspecting the schema is the failure mode
 * this whole feature exists to prevent, so nothing here infers anything about
 * the database — the operator asserts, the runner records.
 */
export async function repairMigration(
  options: RunnerOptions,
  request: RepairRequest,
): Promise<RepairResult> {
  const logger = options.logger ?? migrationLogger;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const migrations = migrationsOf(options);
  const file = migrations.find((m) => m.id === request.id) ?? null;

  const client = await options.pool.connect();
  try {
    const run = await withMigrationLock(client, lockTimeoutMs, async () => {
      await ensureLedger(client);
      const snapshot = await readLedger(client);
      const row = snapshot.rows.find((r) => r.id === request.id);
      if (!row) return { outcome: 'not_found' as const, id: request.id };

      await applyRepair(
        client,
        request.id,
        request.resolution,
        file?.checksum ?? null,
        request.actor,
        request.reason,
      );
      logger.warn('migration.repair', {
        migration_id: request.id,
        from_status: row.status,
        resolution: request.resolution,
        actor: request.actor,
        reason: request.reason,
      });
      return { outcome: 'repaired' as const, id: request.id, resolution: request.resolution };
    });

    if (run.outcome === 'timeout') {
      logger.error('migration.lock_timeout', { waited_ms: run.waitedMs });
      return { outcome: 'lock_timeout', lock_wait_ms: run.waitedMs };
    }
    return run.value;
  } finally {
    client.release();
  }
}
