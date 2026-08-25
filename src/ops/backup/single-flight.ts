/**
 * Issue #520 §2 — global single-flight for backup/restore/retention jobs.
 *
 * Baseline gap: the nightly cron (`src/workers/index.ts` `nightly_backup`) and
 * the CLI (`npm run backup`) could run concurrently, each spawning its own
 * `pg_dump` against the same directory. Two dumps racing on the same target
 * name produce a corrupt artifact that still "succeeds".
 *
 * Mechanism mirrors the established pattern in
 * `src/workers/outbound-messages-sweeper.ts` (`pg_try_advisory_lock` on a
 * dedicated pool client, released in `finally`) but is generalised and
 * dependency-injected so it can be unit-tested without Postgres.
 *
 * A concurrent caller gets `{ status: 'already_running' }` — it does NOT wait,
 * does NOT start a second dump, and does NOT report failure. That is the
 * issue's requirement: "um job concorrente retorna 'already running' com run
 * ID, sem iniciar segundo dump".
 */
import { TypedError } from '@/lib/utils.js';

/**
 * Namespace seed for the ops advisory-lock keyspace. Distinct from
 * OUTBOUND_SWEEPER_LOCK_NAMESPACE (4712_4712n) and every other consumer so the
 * keyspaces never collide. MUST NOT change between deploys — an acquire on a
 * new key and a release on the old key would not round-trip.
 */
export const OPS_LOCK_NAMESPACE = 5200_5200n;

/** Distinct lock keys. One job class per key so backup never blocks retention. */
export const OPS_LOCK_KEYS = {
  backup_run: 'maia_ops_backup_run',
  restore_drill: 'maia_ops_restore_drill',
  retention_run: 'maia_ops_retention_run',
  tombstone_reconcile: 'maia_ops_tombstone_reconcile',
  // Issue #536 — o varredor do TTL do export. CHAVE PRÓPRIA, e não a de
  // `retention_run`: o varredor apaga ARQUIVOS numa árvore que nenhum outro
  // passe toca, e compartilhar a chave faria uma varredura de TTL bloquear a
  // execução de um pedido de exclusão de titular (e vice-versa) sem que as duas
  // disputem uma única linha. O que impede a corrida com um pedido é a
  // releitura do binding imediatamente antes da remoção, não o lock.
  privacy_export_sweep: 'maia_ops_privacy_export_sweep',
} as const;

export type OpsLockKey = (typeof OPS_LOCK_KEYS)[keyof typeof OPS_LOCK_KEYS];

/** Minimal surface of a `pg.PoolClient` this module needs — keeps it testable. */
export interface LockClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

export interface LockPool {
  connect(): Promise<LockClient>;
}

export interface AcquiredLock {
  /** Idempotent: safe to call from both the happy path and `finally`. */
  release(): Promise<void>;
}

export interface SingleFlightDeps {
  pool: LockPool;
  /** Non-throwing warn sink (defaults to no-op so tests stay quiet). */
  onWarn?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Try to take the named global lock. Returns `null` when another process holds
 * it, or when even connecting failed (treated as "could not acquire" — the
 * next tick retries; we never proceed unguarded).
 */
export async function tryAcquireOpsLock(
  key: OpsLockKey,
  deps: SingleFlightDeps,
): Promise<AcquiredLock | null> {
  const warn = deps.onWarn ?? (() => undefined);
  let client: LockClient;
  try {
    client = await deps.pool.connect();
  } catch (err) {
    warn('ops_lock.connect_failed', { key, err: (err as Error).message });
    return null;
  }

  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked',
      [key, OPS_LOCK_NAMESPACE.toString()],
    );
    if (res.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    warn('ops_lock.acquire_failed', { key, err: (err as Error).message });
    return null;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [
          key,
          OPS_LOCK_NAMESPACE.toString(),
        ]);
      } catch (err) {
        // Non-fatal: the session ending releases the lock anyway.
        warn('ops_lock.release_failed', { key, err: (err as Error).message });
      } finally {
        client.release();
      }
    },
  };
}

export type SingleFlightResult<T> =
  | { status: 'ran'; result: T }
  | { status: 'already_running' };

/**
 * Run `fn` under the named global lock, releasing in `finally` on BOTH the
 * success and the error path (the baseline restore drill leaked its ephemeral
 * DB precisely because cleanup lived on the happy path only).
 */
export async function withOpsLock<T>(
  key: OpsLockKey,
  deps: SingleFlightDeps,
  fn: () => Promise<T>,
): Promise<SingleFlightResult<T>> {
  const lock = await tryAcquireOpsLock(key, deps);
  if (!lock) return { status: 'already_running' };
  try {
    return { status: 'ran', result: await fn() };
  } finally {
    await lock.release();
  }
}

/**
 * Fail-closed variant for destructive paths (retention purge, tombstone
 * reconciliation): losing the lock race must not be silently treated as
 * "nothing to do" by a caller that forgot to check the status.
 */
export async function requireOpsLock<T>(
  key: OpsLockKey,
  deps: SingleFlightDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const outcome = await withOpsLock(key, deps, fn);
  if (outcome.status === 'already_running') {
    throw new TypedError(
      'ops_lock_unavailable',
      `another process holds the '${key}' lock — refusing to run a second destructive pass`,
      { key },
    );
  }
  return outcome.result;
}
