/**
 * `maia doctor` — the read-only Postgres handle (issue #517 §2).
 *
 * The read-only guarantee here is enforced by the SERVER, not by our own
 * discipline: every statement runs inside `BEGIN READ ONLY … ROLLBACK`, so an
 * `INSERT`/`UPDATE`/`DELETE`/DDL is refused by Postgres with SQLSTATE `25006`
 * ("cannot execute … in a read-only transaction") regardless of what the check
 * author wrote. `tests/integration/doctor-read-only-real-db.spec.ts` proves it
 * against a real database by pushing a mutation THROUGH this handle and
 * asserting the rejection plus the absence of the row.
 *
 * Why a transaction and not just `default_transaction_read_only=on` at connect
 * time: the session GUC is the belt (the CLI sets it too), this is the braces.
 * A GUC can be overridden by a later `SET`, by a pooler that resets the session
 * or by a connection string that the operator supplied; `BEGIN READ ONLY` is
 * per-transaction and cannot be un-set from inside the transaction.
 *
 * The `ROLLBACK` (rather than `COMMIT`) is deliberate too — nothing this
 * process opens is ever committed, not even an empty transaction.
 */
import pg from 'pg';
import type { DoctorPostgres } from './types.js';

/** Minimal `pg` shape. Structural so tests need no real driver. */
export interface PgQueryResult<R> {
  readonly rows: R[];
}

export interface PgClientLike {
  query<R extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

export interface ReadOnlyPostgresOptions {
  /**
   * Server-side statement timeout applied inside each transaction. It is the
   * only cancellation that actually stops work in the DATABASE — the runner's
   * AbortSignal bounds our wall clock, not Postgres'.
   */
  readonly statementTimeoutMs?: number;
}

export const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;

/**
 * Wrap a pool into the narrow read-only handle checks receive.
 *
 * Closes what it opens: the pooled client is released in `finally`, including
 * on the failure path where `ROLLBACK` itself throws (a dead connection).
 */
export function readOnlyPostgres(
  pool: PgPoolLike,
  options: ReadOnlyPostgresOptions = {},
): DoctorPostgres {
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  return {
    async query<R extends Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<readonly R[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        try {
          // Integer-formatted, not parameterised: SET does not take bind
          // parameters. The value is a number we produced, never operator text.
          await client.query(`SET LOCAL statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
          const res = await client.query<R>(sql, values);
          return res.rows;
        } finally {
          await client.query('ROLLBACK').catch(() => {
            /* connection already gone; the transaction dies with it */
          });
        }
      } finally {
        client.release();
      }
    },
  };
}

/** SQLSTATE Postgres raises for a write attempted in a read-only transaction. */
export const READ_ONLY_SQLSTATE = '25006';

/**
 * Connection ceiling for the doctor's own pool. It is not a workload — it is
 * sized to the runner's concurrency (`DEFAULT_CONCURRENCY`) plus one for the
 * schema-readiness evaluation, so a wave of independent checks does not wait
 * on `connectionTimeoutMillis` for a free client.
 */
export const DOCTOR_POOL_MAX = 5;

/**
 * THE pool the doctor connects with — the single place both halves of the
 * read-only guarantee are configured.
 *
 * It lives in production code, not in `scripts/doctor.ts`, so the integration
 * spec can drive the REAL construction instead of rebuilding it. A spec that
 * assembles its own pool with its own `options` string is the mirror trap: it
 * would keep proving "a read-only pool refuses writes" long after the CLI
 * stopped building one.
 *
 * Two mechanisms, deliberately redundant:
 *   - `default_transaction_read_only=on` — the SESSION belt, applied by the
 *     server to every transaction this connection opens;
 *   - `BEGIN READ ONLY` in `readOnlyPostgres()` — the per-transaction braces,
 *     which a later `SET`, a pooler session reset or an operator-supplied
 *     connection string cannot undo.
 *
 * Neither alone is the guarantee, and that is the point: removing either one
 * still leaves a doctor that cannot write.
 */
export function doctorPostgresPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: DOCTOR_POOL_MAX,
    connectionTimeoutMillis: 4_000,
    idleTimeoutMillis: 1_000,
    options: '-c default_transaction_read_only=on',
  });
  // A pool `error` event with no listener is an uncaught exception that would
  // kill the process in the middle of writing the report.
  pool.on('error', () => {
    /* surfaced by whichever check touched the connection */
  });
  return pool;
}
