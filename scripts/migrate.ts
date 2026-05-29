import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '@/config/env.js';

// Migrations that need to run outside a transaction (e.g. `CREATE INDEX
// CONCURRENTLY`, which Postgres rejects inside `BEGIN/COMMIT`) opt-in by
// putting `-- maia:no-transaction` on its own line at the top of the file.
export const NO_TX_MARKER = /^[ \t]*--[ \t]*maia:no-transaction\b/m;

/**
 * Split a no-transaction migration into individual statements.
 *
 * Why this is required: node-postgres' simple-query protocol wraps
 * MULTIPLE statements sent in one `client.query()` call in an implicit
 * transaction. So a no-tx file with more than one `CREATE INDEX
 * CONCURRENTLY` (e.g. migration 066) still fails with
 * "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"
 * unless each statement is sent on its own. We strip `--` line comments
 * and split on `;`.
 *
 * Constraint: no-transaction migrations may ONLY contain simple
 * statements terminated by a top-level `;` (CONCURRENTLY index DDL).
 * They must NOT contain dollar-quoted bodies (`DO $$ ... $$`) or string
 * literals containing `;` — anything that complex can and should run
 * inside a transaction (i.e. without the marker), where the whole file
 * is sent as one query. This keeps the splitter dependency-free and safe.
 */
export function splitNoTxStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function main() {
  const dir = join(process.cwd(), 'migrations');
  // `_down.sql` files are rollback scripts run manually via `psql -f` —
  // see docs/runbooks/migrations.md. Skip them here so the forward chain
  // doesn't drop and recreate the schema on every run.
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();

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
        // Each statement is sent on its own — node-postgres wraps multiple
        // statements in a single query() call in an implicit transaction,
        // which CONCURRENTLY rejects. See splitNoTxStatements above.
        // If the process crashes between the SQL succeeding and the
        // schema_migrations insert, a re-run lands here again — IF NOT EXISTS
        // in the migration body keeps it idempotent, and ON CONFLICT DO
        // NOTHING ensures we don't fail just because the row already exists.
        for (const stmt of splitNoTxStatements(sql)) {
          await client.query(stmt);
        }
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

/**
 * Only run `main()` when this file is the process entrypoint — NOT when a
 * test imports it to exercise the pure helpers (splitNoTxStatements /
 * NO_TX_MARKER). Mirrors the cross-platform `isDirectInvocation` guard in
 * scripts/embeddings-rebuild.ts: `import.meta.url` is a `file://` URL;
 * argv[1] is a filesystem path, normalised via `pathToFileURL` so the
 * comparison holds on Windows (`file:///C:/...`) and POSIX alike.
 */
export function isDirectInvocation(
  entry: string | undefined,
  metaUrl: string,
): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.MIGRATE_NO_MAIN) {
  main();
}
