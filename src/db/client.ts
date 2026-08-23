import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// Módulo COMPARTILHADO por mais de um container (runtime e admin-ui): lê o
// contrato sob demanda em vez de arrastar o boot do subset `runtime` para
// dentro do console. Ver src/config/contract-env.ts (issue #596).
import { contractEnv as config } from '@/config/contract-env.js';
import { recordDbQuery } from './query-counter.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

let dbConnected = false;
let lastProbe = 0;
const DB_HEALTH_CACHE_MS = 5000;

pool.on('error', (err) => {
  dbConnected = false;
  console.error('pg pool error', err);
});

/**
 * Synchronous gauge for `/metrics`. Returns the cached connectivity state
 * — refreshed in the background by `probeDb()`. We can't make Prometheus
 * scrapes block on a live `SELECT 1`, so the gauge tracks the *last* probe
 * outcome (≤ 5s old) instead of running a query per scrape.
 */
export function isDbConnected(): boolean {
  return dbConnected;
}

/**
 * Best-effort liveness probe. Cheap (`SELECT 1`) and rate-limited to 1
 * call per 5s so a tight Prometheus scrape loop doesn't hammer the DB.
 * Errors flip the cached state; success restores it. Safe to call from
 * anywhere — it never throws.
 */
export async function probeDb(): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbe < DB_HEALTH_CACHE_MS) return dbConnected;
  lastProbe = now;
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      dbConnected = true;
    } finally {
      client.release();
    }
  } catch {
    dbConnected = false;
  }
  return dbConnected;
}

/**
 * Issue #511 — transparent query-counting wrapper around the pg client handed
 * to drizzle.
 *
 * Every drizzle statement bottoms out in `client.query(...)` (see
 * `drizzle-orm/node-postgres/session.js`), so intercepting that single method
 * yields an exact DB round-trip count for whatever `runWithQueryCounter` frame
 * is open — the number the turn-context budget in issue #511 is measured
 * against.
 *
 * Deliberately a `Proxy` rather than a monkey-patch of `pool.query`:
 *   - the exported `pool` keeps its exact pg semantics (`pool.end()` in
 *     `shutdownDb`, `pool.connect()` in `probeDb`/`withTx`, the `error` event
 *     handler above) — nothing outside drizzle changes behaviour;
 *   - the proxy is transparent to drizzle's own type probes: `isConfig()`
 *     reads `constructor.name` (forwarded → `BoundPool`, not `Object`) and the
 *     transaction path does `client instanceof Pool` (forwarded through the
 *     prototype chain), so both still classify it as a pool.
 *
 * Zero behavioural change when no counter frame is open: `recordDbQuery()` is
 * an ALS read plus a null check.
 */
function instrumentQueries<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== 'query' || typeof value !== 'function') return value;
      return function instrumentedQuery(this: unknown, ...args: unknown[]): unknown {
        recordDbQuery();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export const db = drizzle(instrumentQueries(pool));

export async function withTx<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // drizzle(client) returns NodePgDatabase & { $client: PoolClient } —
    // structurally identical to `db` for query purposes; the unknown-bridge
    // cast tells TS the $client divergence is intentional.
    // #511: the transaction's client is instrumented too, so statements issued
    // through `tx` are counted the same as statements issued through `db`.
    const tx = drizzle(instrumentQueries(client)) as unknown as typeof db;
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Extract a PostgreSQL `SQLSTATE` error code (e.g. `'23505'` for a unique
 * violation) from an error, walking the `cause` chain.
 *
 * Drizzle (>=0.44) wraps every driver error in a `DrizzleQueryError` whose own
 * `.code` is `undefined`; the underlying `pg` error (which carries `.code`)
 * sits on `.cause`. Callers that switch on pg SQLSTATE codes (e.g. mapping a
 * `23505` to a typed `duplicate_id` result instead of letting it surface as a
 * 500) MUST go through here rather than reading `err.code` directly, or the
 * wrapper hides the real code and the mapping silently never fires.
 *
 * A small depth bound guards against pathological/cyclic cause chains.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function shutdownDb(): Promise<void> {
  await pool.end();
}
