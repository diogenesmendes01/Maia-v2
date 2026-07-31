/**
 * Global migration advisory lock (issue #516 §3).
 *
 * ONE migrator applies changes per database. Not "usually one" — the lock is
 * held on a DEDICATED client for the whole run and released in `finally`, so a
 * second migrator either waits or exits with a typed result. It never runs
 * concurrently, and it never silently skips work believing it was already
 * done.
 *
 * WHAT THE LOCK DOES NOT DO: it does not make a migration semantically safe.
 * Two replicas of the SAME release serialise correctly here; a migration that
 * takes an ACCESS EXCLUSIVE lock on a hot table still blocks traffic. The lock
 * is about not corrupting the ledger, not about zero downtime.
 */
import type { PoolClient } from 'pg';

/**
 * Advisory lock namespace, as a two-int32 key so it can never collide with a
 * single-bigint lock taken elsewhere in the codebase.
 *
 *   classid = 0x4D414941 = 1296124225 — ASCII "MAIA", the Maia namespace.
 *   objid   = 1                        — object #1 in that namespace: the
 *                                        global schema-migration lock.
 *
 * Register any future Maia advisory lock HERE (objid 2, 3, …) so the namespace
 * stays auditable from one place.
 */
export const MIGRATION_LOCK_CLASSID = 0x4d414941;
export const MIGRATION_LOCK_OBJID = 1;

/** Postgres SQLSTATE raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

export type LockOutcome =
  | { readonly acquired: true; readonly waitedMs: number }
  | { readonly acquired: false; readonly waitedMs: number; readonly reason: 'timeout' };

/**
 * Try to take the global migration lock on `client`, waiting at most
 * `timeoutMs`.
 *
 * Implemented with `SET lock_timeout` + blocking `pg_advisory_lock` rather
 * than a `pg_try_advisory_lock` poll loop: the wait is then a single server-
 * side operation with fair queueing, and the caller gets an accurate
 * `waitedMs` for the `migration.lock_wait` log instead of a rounded-up
 * polling interval.
 *
 * The lock is SESSION-scoped, so it survives the individual transactions the
 * runner opens per migration — which is exactly what a no-transaction
 * migration needs.
 */
export async function acquireMigrationLock(
  client: PoolClient,
  timeoutMs: number,
): Promise<LockOutcome> {
  const startedAt = Date.now();
  // `lock_timeout` takes an integer number of milliseconds; it is set on the
  // SESSION (not LOCAL) because the advisory lock is acquired outside any
  // transaction block.
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      MIGRATION_LOCK_CLASSID,
      MIGRATION_LOCK_OBJID,
    ]);
    return { acquired: true, waitedMs: Date.now() - startedAt };
  } catch (err) {
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      return { acquired: false, waitedMs: Date.now() - startedAt, reason: 'timeout' };
    }
    throw err;
  } finally {
    // Never leave a session-wide lock_timeout behind for the migrations
    // themselves — a migration that legitimately waits on a table lock must
    // not inherit the (much shorter) budget meant for the advisory lock.
    await client.query('SET lock_timeout = 0').catch(() => undefined);
  }
}

/** Release the global migration lock. Safe to call when it was never held. */
export async function releaseMigrationLock(client: PoolClient): Promise<void> {
  await client
    .query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_CLASSID, MIGRATION_LOCK_OBJID])
    .catch(() => undefined);
}

/**
 * Run `fn` while holding the global migration lock.
 *
 * Returns `null` when the lock could not be taken within `timeoutMs` — the
 * caller turns that into a typed `lock_timeout` outcome rather than an
 * exception, because "another migrator is working" is an expected state during
 * a rolling deploy, not an error.
 */
export async function withMigrationLock<T>(
  client: PoolClient,
  timeoutMs: number,
  fn: (waitedMs: number) => Promise<T>,
): Promise<{ outcome: 'ran'; value: T; waitedMs: number } | { outcome: 'timeout'; waitedMs: number }> {
  const lock = await acquireMigrationLock(client, timeoutMs);
  if (!lock.acquired) return { outcome: 'timeout', waitedMs: lock.waitedMs };
  try {
    return { outcome: 'ran', value: await fn(lock.waitedMs), waitedMs: lock.waitedMs };
  } finally {
    await releaseMigrationLock(client);
  }
}
