/**
 * Issue #516 §3 — the global migration advisory lock.
 *
 * Invariant: **at most one migrator applies changes to a database at a time.**
 * Two replicas booting the same release, or a CI job racing the deploy job,
 * must not both walk the pending list — the second one would try to re-apply a
 * migration the first is halfway through.
 *
 * Shape mirrors the established Maia pattern in
 * `src/ops/backup/single-flight.ts`: session-level `pg_advisory_lock` taken on
 * a DEDICATED client, released in `finally`. Dedicated matters — a session
 * advisory lock belongs to the connection that took it, so borrowing a pooled
 * client per statement would release the lock the moment that client went back
 * to the pool.
 *
 * Waiting instead of failing: unlike the backup single-flight (where a
 * concurrent run is simply skipped), a second migrator WAITS. Two replicas
 * starting together both need the schema to reach head before they serve; the
 * loser should block until the winner is done, then observe "nothing pending",
 * not exit with an error. It gives up after `waitMs` with a TYPED result — the
 * caller decides the exit code; this module never calls `process.exit()`.
 *
 * We poll `pg_try_advisory_lock` rather than blocking inside
 * `pg_advisory_lock`, because a blocked backend is invisible: polling lets the
 * runner emit `migration.lock_wait` progress, honour a precise deadline, and be
 * unit-tested with an injected clock and no Postgres.
 *
 * Global by design: schema DDL is not tenant-scoped (see `types.ts`), so this
 * is ONE key for the whole database, not one per tenant/agent.
 */

/**
 * Namespace seed for the migration advisory-lock keyspace. Distinct from
 * `OPS_LOCK_NAMESPACE` (5200_5200n, src/ops/backup/single-flight.ts) and from
 * the outbound sweeper's (4712_4712n) so the keyspaces can never collide.
 *
 * MUST NOT change between deploys: an acquire on a new key and a release on the
 * old key would not round-trip, and — worse — two releases using different
 * namespaces would not exclude each other.
 */
export const MIGRATION_LOCK_NAMESPACE = 5160_5160n;

/** The single global key. One lock per database, not per tenant/agent. */
export const MIGRATION_LOCK_KEY = 'maia_schema_migrations';

/** Default ceiling on how long a second migrator waits for the first. */
export const DEFAULT_LOCK_WAIT_MS = 30_000;

/** Default gap between `pg_try_advisory_lock` attempts. */
export const DEFAULT_LOCK_POLL_MS = 500;

/** Minimal surface of a `pg.PoolClient` this module needs — keeps it testable. */
export interface LockClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

export interface LockPool {
  connect(): Promise<LockClient>;
}

export interface MigrationLock {
  /** Idempotent: safe to call from both the happy path and `finally`. */
  release(): Promise<void>;
  /** The dedicated client holding the lock — migrations run on it. */
  readonly client: LockClient;
}

export type LockFailureReason = 'timeout' | 'connect_failed' | 'query_failed';

export type LockAcquisition =
  | { readonly acquired: true; readonly lock: MigrationLock; readonly waited_ms: number }
  | {
      readonly acquired: false;
      readonly reason: LockFailureReason;
      readonly waited_ms: number;
      /** Error CLASS only — never a driver message (it can carry the DSN). */
      readonly error_class?: string;
    };

export interface LockDeps {
  readonly pool: LockPool;
  /** Structured, redaction-safe event sink. */
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LockOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
}

function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error) return err.constructor.name;
  return 'UnknownError';
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Take the global migration lock, waiting up to `waitMs`.
 *
 * Never throws: connection and query failures come back as a typed
 * non-acquisition, because "we could not prove we are alone" must be handled by
 * the caller as a refusal to migrate, not as an exception that some `catch`
 * higher up might swallow into a warning.
 */
export async function acquireMigrationLock(
  deps: LockDeps,
  options: LockOptions = {},
): Promise<LockAcquisition> {
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const emit = deps.onEvent ?? (() => undefined);
  const startedAt = now();

  let client: LockClient;
  try {
    client = await deps.pool.connect();
  } catch (err) {
    return {
      acquired: false,
      reason: 'connect_failed',
      waited_ms: now() - startedAt,
      error_class: errorClass(err),
    };
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked',
        [MIGRATION_LOCK_KEY, MIGRATION_LOCK_NAMESPACE.toString()],
      );
      if (res.rows[0]?.locked === true) {
        const waited = now() - startedAt;
        emit('migration.lock_acquired', { waited_ms: waited, attempts: attempt });
        return { acquired: true, lock: makeLock(client, emit), waited_ms: waited };
      }
    } catch (err) {
      client.release();
      return {
        acquired: false,
        reason: 'query_failed',
        waited_ms: now() - startedAt,
        error_class: errorClass(err),
      };
    }

    const elapsed = now() - startedAt;
    if (elapsed + pollMs > waitMs) {
      client.release();
      emit('migration.lock_wait', { waited_ms: elapsed, attempts: attempt, outcome: 'timeout' });
      return { acquired: false, reason: 'timeout', waited_ms: elapsed };
    }
    emit('migration.lock_wait', { waited_ms: elapsed, attempts: attempt, outcome: 'retrying' });
    await sleep(pollMs);
  }
}

function makeLock(
  client: LockClient,
  emit: (event: string, detail: Record<string, unknown>) => void,
): MigrationLock {
  let released = false;
  return {
    client,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [
          MIGRATION_LOCK_KEY,
          MIGRATION_LOCK_NAMESPACE.toString(),
        ]);
      } catch (err) {
        // Non-fatal: ending the session releases the lock anyway. Log the
        // CLASS, never the driver message.
        emit('migration.lock_release_failed', { error_class: errorClass(err) });
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Run `fn` under the global migration lock, releasing on BOTH the success and
 * the error path. Returns the typed non-acquisition unchanged when the lock
 * could not be taken — the caller must handle it (never migrate unguarded).
 */
export async function withMigrationLock<T>(
  deps: LockDeps,
  options: LockOptions,
  fn: (lock: MigrationLock) => Promise<T>,
): Promise<{ acquired: true; result: T } | Extract<LockAcquisition, { acquired: false }>> {
  const acquisition = await acquireMigrationLock(deps, options);
  if (!acquisition.acquired) return acquisition;
  try {
    return { acquired: true, result: await fn(acquisition.lock) };
  } finally {
    await acquisition.lock.release();
  }
}
