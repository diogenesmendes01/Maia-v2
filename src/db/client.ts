import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '@/config/env.js';

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

export const db = drizzle(pool);

export async function withTx<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // drizzle(client) returns NodePgDatabase & { $client: PoolClient } —
    // structurally identical to `db` for query purposes; the unknown-bridge
    // cast tells TS the $client divergence is intentional.
    const tx = drizzle(client) as unknown as typeof db;
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

export async function shutdownDb(): Promise<void> {
  await pool.end();
}
