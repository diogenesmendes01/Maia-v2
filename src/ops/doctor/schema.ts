/**
 * `maia doctor` — the READ-ONLY seam for the schema verdict (issue #517).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why this file exists at all
 * ───────────────────────────────────────────────────────────────────────────
 * `getSchemaReadiness()` (#516) is the one consumer of the doctor's pool that
 * does NOT go through `readOnlyPostgres()`: it wants a pool it can borrow a
 * client from and issue several statements against, and the narrow
 * `DoctorPostgres` handle only exposes one statement at a time. The adapter
 * that satisfied that shape used to hand over a raw pooled client, and that
 * left a real hole:
 *
 *   - no `BEGIN READ ONLY … ROLLBACK`, so the per-transaction half of the
 *     read-only guarantee did not cover this path (only the session GUC did),
 *     and the negative test that pushes a mutation through `ctx.postgres` was
 *     not exercising this seam at all;
 *   - no `SET LOCAL statement_timeout`, so nothing in the DATABASE bounded the
 *     query. The runner's `Promise.race` would record a timeout while the
 *     query kept holding the client, and the CLI's `finally` then waited on
 *     `pool.end()`, which waits for that client — a blocked read could push
 *     the command past BOTH the per-check deadline and the total one.
 *
 * Both halves are closed here, in production code rather than in
 * `scripts/doctor.ts`, so the integration spec drives the REAL construction
 * instead of rebuilding a look-alike.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Three bounds, and what each one actually stops
 * ───────────────────────────────────────────────────────────────────────────
 *   1. `BEGIN READ ONLY` — the SERVER refuses a write with SQLSTATE 25006,
 *      whatever the caller passed in. Same guarantee the other checks get.
 *   2. `SET LOCAL statement_timeout` — the only bound that stops work inside
 *      Postgres. It is deliberately smaller than the check's deadline, and the
 *      read path issues at most three statements (`describeLedger` +
 *      `readLedger` + `readInvalidIndexes`, the last added by #658), so the
 *      whole evaluation cannot outlive the deadline by waiting on the server.
 *   3. The check's `AbortSignal` — the wall-clock backstop. When it fires we
 *      stop waiting AND destroy the connection, because a client abandoned
 *      mid-query must never go back to the pool: `pool.end()` would wait on
 *      it, which is precisely the hang this file exists to prevent. Closing
 *      the socket is also what cancels the statement server-side.
 */
import { getSchemaReadiness, type ReadOnlyPool } from '@/migrations/index.js';
import type { SchemaReadiness } from '@/migrations/types.js';
import type { PgPoolLike } from './postgres.js';

/**
 * Server-side ceiling for each statement of the schema evaluation.
 *
 * MUST stay below `schemaReadinessCheck.deadlineMs` (10s) with room for EVERY
 * statement the read path issues. Since #658 that is three — `describeLedger`,
 * `readLedger` and `readInvalidIndexes` — so the ceiling dropped from 4s to 3s:
 * 3s × 3 = 9s < 10s, where 4s × 3 = 12s would have let a slow catalog read blow
 * the check's deadline before the server cut the statement.
 * `tests/unit/ops/doctor-schema.spec.ts` pins the inequality against the real
 * statement count, so adding a fourth statement fails the test instead of
 * silently widening the window.
 */
export const SCHEMA_READINESS_STATEMENT_TIMEOUT_MS = 3_000;

/**
 * Quantas consultas o caminho de leitura de `getSchemaReadiness()` emite dentro
 * da transação READ ONLY. Exportado para o teste multiplicar pelo teto acima em
 * vez de repetir um `2` (ou um `3`) que envelhece.
 */
export const SCHEMA_READINESS_STATEMENT_COUNT = 3;

export interface ReadOnlySchemaOptions {
  readonly statementTimeoutMs?: number;
  /** The check's deadline signal. Without it there is no wall-clock backstop. */
  readonly signal?: AbortSignal;
}

/** Raised when the deadline fired before the evaluation answered. */
export class SchemaEvaluationAbortedError extends Error {
  readonly code = 'DOCTOR_SCHEMA_EVALUATION_ABORTED';
  constructor() {
    super('a avaliação de schema foi abandonada: o deadline do check foi atingido');
    this.name = 'SchemaEvaluationAbortedError';
  }
}

/**
 * Run `evaluate` against ONE pooled client held inside a read-only
 * transaction, and guarantee the client is given up afterwards either way.
 *
 * Exported (and generic) so a test can push a real mutation through the very
 * adapter the CLI uses, instead of through a mirror of it.
 */
export async function withReadOnlySchemaTransaction<T>(
  pool: PgPoolLike,
  evaluate: (roPool: ReadOnlyPool) => Promise<T>,
  options: ReadOnlySchemaOptions = {},
): Promise<T> {
  const timeoutMs = Math.trunc(
    options.statementTimeoutMs ?? SCHEMA_READINESS_STATEMENT_TIMEOUT_MS,
  );
  const signal = options.signal;
  const client = await pool.connect();
  let abandoned = false;
  let onAbort: (() => void) | undefined;

  try {
    await client.query('BEGIN READ ONLY');
    // Integer-formatted, not parameterised: SET takes no bind parameters. The
    // value is a number we produced, never operator text.
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const roPool: ReadOnlyPool = {
      connect: () =>
        Promise.resolve({
          query: <R>(text: string, values?: unknown[]) =>
            client.query(text, values as readonly unknown[]) as unknown as Promise<{
              rows: R[];
            }>,
          // The client's LIFETIME belongs to this function. Releasing here
          // would return a client that is still inside an open transaction.
          release: () => {
            /* owned by withReadOnlySchemaTransaction */
          },
        }),
    };

    if (signal === undefined) return await evaluate(roPool);

    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        abandoned = true;
        reject(new SchemaEvaluationAbortedError());
        return;
      }
      onAbort = () => {
        abandoned = true;
        reject(new SchemaEvaluationAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // `Promise.race` subscribes to both, so the loser's rejection is handled
    // and never surfaces as an unhandled rejection.
    return await Promise.race([evaluate(roPool), aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (abandoned) {
      // A statement may still be in flight on this connection. ROLLBACK would
      // queue BEHIND it and the release would hand a busy socket to the next
      // borrower; destroying closes it, which frees `pool.end()` and cancels
      // the statement server-side.
      client.release(true);
    } else {
      await client.query('ROLLBACK').catch(() => {
        /* connection already gone; the transaction dies with it */
      });
      client.release();
    }
  }
}

export interface SchemaReadinessDeps extends ReadOnlySchemaOptions {
  readonly pool: PgPoolLike;
  readonly migrationsDir: string;
}

/**
 * THE binding `scripts/doctor.ts` puts on `DoctorContext.schemaReadiness`.
 *
 * `getSchemaReadiness()` never throws, so the only rejection this can produce
 * is the abandonment above — and the runner is already racing the same signal,
 * so it reports the check as a timed-out `fail` rather than as a surprise.
 */
export function evaluateSchemaReadiness(deps: SchemaReadinessDeps): Promise<SchemaReadiness> {
  const { pool, migrationsDir, ...options } = deps;
  return withReadOnlySchemaTransaction(
    pool,
    (roPool) => getSchemaReadiness({ pool: roPool, migrationsDir }),
    options,
  );
}
