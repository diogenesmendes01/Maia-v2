import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '@/config/env.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('pg pool error', err);
});

export const db = drizzle(pool);

// --- DB health gauge support ---------------------------------------------
// Cached health flag for the `maia_db_connected` Prometheus gauge. Refreshed
// every 5s by a background `SELECT 1` ping. The timer is started lazily on
// the first call to `isDbConnected()` so unit tests that never query DB
// connectivity don't spawn a stray interval.
const DB_PING_INTERVAL_MS = 5_000;
let cachedDbHealthy = false;
let pingTimerStarted = false;
let pingTimer: NodeJS.Timeout | null = null;

function runPing(): void {
  pool
    .query('SELECT 1')
    .then(() => {
      cachedDbHealthy = true;
    })
    .catch(() => {
      cachedDbHealthy = false;
    });
}

function ensurePingTimer(): void {
  if (pingTimerStarted) return;
  pingTimerStarted = true;
  // Fire an initial ping right away so the gauge can leave its `false`
  // default state without waiting a full interval.
  runPing();
  pingTimer = setInterval(runPing, DB_PING_INTERVAL_MS);
  // `unref()` keeps the interval from blocking process shutdown — important
  // for short-lived scripts and tests.
  pingTimer.unref();
}

/**
 * Returns the cached DB connectivity flag for Prometheus / health probes.
 *
 * The signal is refreshed every 5 seconds by a background `SELECT 1` ping;
 * the very first call lazily starts the interval and triggers an immediate
 * ping (so the value can flip from its `false` default without waiting a
 * full cycle). Callers should treat it as a low-resolution signal: a fresh
 * outage may take up to ~5s to surface.
 */
export function isDbConnected(): boolean {
  ensurePingTimer();
  return cachedDbHealthy;
}

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
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
    pingTimerStarted = false;
  }
  await pool.end();
}
