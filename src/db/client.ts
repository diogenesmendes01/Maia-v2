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
  // eslint-disable-next-line no-console
  console.error('pg pool error', err);
});

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
