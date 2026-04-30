import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '@/config/env.js';

// Migrations that need to run outside a transaction (e.g. `CREATE INDEX
// CONCURRENTLY`, which Postgres rejects inside `BEGIN/COMMIT`) opt-in by
// putting `-- maia:no-transaction` on its own line at the top of the file.
const NO_TX_MARKER = /^[ \t]*--[ \t]*maia:no-transaction\b/m;

async function main() {
  const dir = join(process.cwd(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await pool.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip ${file}`);
      continue;
    }
    console.log(`> apply ${file}`);
    const sql = await readFile(join(dir, file), 'utf8');
    const useTx = !NO_TX_MARKER.test(sql);
    const client = await pool.connect();
    try {
      if (useTx) {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ok ${file}`);
      } else {
        // No-tx path: the SQL itself is non-transactional (e.g. CONCURRENTLY).
        // If the process crashes between the SQL succeeding and the
        // schema_migrations insert, a re-run lands here again — IF NOT EXISTS
        // in the migration body keeps it idempotent, and ON CONFLICT DO
        // NOTHING ensures we don't fail just because the row already exists.
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
          [file],
        );
        console.log(`  ok ${file} (no-tx)`);
      }
    } catch (err) {
      if (useTx) await client.query('ROLLBACK').catch(() => undefined);
      console.error(`  FAILED ${file}:`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations done');
}

main();
