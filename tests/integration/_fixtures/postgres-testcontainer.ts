/**
 * Real-Postgres test fixture backed by testcontainers-node.
 *
 * Boots an ephemeral Postgres (pgvector/pgvector:pg16 — same image production
 * uses, see docker-compose.yml) for tests that need to prove behaviour on
 * REAL Postgres semantics, not against an in-memory drizzle fake. Today the
 * only consumer is the cross-tenant isolation proof for issue #218, but the
 * helper is generic enough to be reused by future real-DB integration specs.
 *
 * Runtime requirement: a Docker daemon reachable to the test process. Locally
 * that means Docker Desktop running; in CI it means a job with Docker enabled
 * (the existing `integration` CI job uses postgres service containers — a
 * separate, Docker-daemon-enabled job would be needed to run testcontainer
 * specs there). When Docker isn't reachable, the helper throws a clear error
 * pointing at the requirement; callers should `describe.skip` based on
 * `isDockerLikelyAvailable()` if they want to keep the test lane green on a
 * Docker-less runner.
 *
 * Migration runner: re-uses the SAME chain as `scripts/migrate.ts` (forward
 * `.sql` files in /migrations, applied in lexical order, each in its own
 * transaction unless `-- maia:no-transaction` opts out). This guarantees the
 * test schema is bit-identical to production. We do NOT reimplement schema
 * creation here.
 *
 * Why we set `DATABASE_URL` before importing `@/db/client.js`: production
 * `db` is constructed at module load from `config.DATABASE_URL` (pg.Pool
 * connection string is captured then). Tests that need to point the real
 * `db` at the testcontainer must mutate `process.env.DATABASE_URL` and then
 * dynamic-import the modules they exercise — never the other way around.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/**
 * Same image production uses (docker-compose.yml). pgvector is required by
 * migration 001 (`CREATE EXTENSION vector`); the upstream `postgres:16-alpine`
 * image would fail that step.
 */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

/**
 * Marker copied verbatim from `scripts/migrate.ts`. Migrations that need to
 * run outside a transaction (e.g. `CREATE INDEX CONCURRENTLY`, which Postgres
 * rejects inside BEGIN/COMMIT) opt-in by putting this on its own line at the
 * top of the file. Keeping the marker spelling identical to the prod runner
 * means a future change to the runner stays single-sourced — only the regex
 * here needs to be updated.
 */
const NO_TX_MARKER = /^[ \t]*--[ \t]*maia:no-transaction\b/m;

/**
 * Split a no-transaction migration into individual statements. Copied
 * verbatim (in behaviour) from `scripts/migrate.ts` so the test schema is
 * built bit-identically to production.
 *
 * Required because node-postgres' simple-query protocol wraps MULTIPLE
 * statements sent in one `client.query()` call in an implicit
 * transaction. A no-tx file with more than one `CREATE INDEX
 * CONCURRENTLY` (e.g. migration 065) therefore still trips
 * "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"
 * unless each statement is executed on its own. We strip `--` line
 * comments and split on `;`.
 *
 * Constraint (same as the prod runner): no-tx migrations may ONLY contain
 * simple `;`-terminated statements (CONCURRENTLY index DDL) — no
 * dollar-quoted bodies or `;`-bearing string literals.
 */
function splitNoTxStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

export interface StartedPostgres {
  /** Started testcontainer handle; pass to `stopPostgresContainer` to tear down. */
  container: StartedPostgreSqlContainer;
  /** Connection string for the started container (postgres://user:pwd@host:port/db). */
  uri: string;
  /** Open pool against the container. Caller owns its lifecycle. */
  pool: pg.Pool;
}

/**
 * Find the migrations directory regardless of where vitest CWD ends up.
 * Resolves from this file's location to `/migrations` at the repo root.
 *
 * Uses `fileURLToPath` from `node:url` to convert the `file://` URL to a
 * native filesystem path. This is the correct way to do it because:
 *   - On Windows, `new URL(...).pathname` returns `/C:/Users/PC%20Di/...`
 *     (leading slash + percent-encoded spaces). The old approach stripped
 *     the leading slash with a regex but left the percent-encoding intact,
 *     breaking on any path that contained a space (e.g. `PC Di`,
 *     `Program Files`).
 *   - `fileURLToPath` is the WHATWG-standard, OS-aware conversion: it
 *     percent-decodes, drops the leading slash on Windows drive letters,
 *     and uses the platform-correct separator.
 */
async function findMigrationsDir(): Promise<string> {
  // tests/integration/_fixtures/postgres-testcontainer.ts → ../../../migrations
  const here = new URL('.', import.meta.url);
  const candidate = new URL('../../../migrations/', here);
  // Smoke-test by reading the directory. `readdir` accepts URL directly.
  await readdir(candidate);
  return fileURLToPath(candidate);
}

/**
 * Apply forward migrations against the connected pool. Mirrors the loop in
 * scripts/migrate.ts:
 *   - sort .sql files lexically, skip *_down.sql
 *   - wrap in BEGIN/COMMIT unless `-- maia:no-transaction` marker is present
 *   - for no-tx files, send each statement separately (node-postgres wraps
 *     a multi-statement query in an implicit transaction, which
 *     CONCURRENTLY rejects — see splitNoTxStatements)
 *   - record each applied migration in `schema_migrations`
 * Returns the number of migrations applied.
 */
async function applyMigrations(pool: pg.Pool): Promise<number> {
  const dir = await findMigrationsDir();
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  let applied = 0;
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const useTx = !NO_TX_MARKER.test(sql);
    const client = await pool.connect();
    try {
      if (useTx) {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } else {
        // Execute each statement separately — node-postgres wraps a
        // multi-statement query() in an implicit transaction, which
        // CONCURRENTLY rejects. See splitNoTxStatements above.
        for (const stmt of splitNoTxStatements(sql)) {
          await client.query(stmt);
        }
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
          [file],
        );
      }
      applied++;
    } catch (err) {
      if (useTx) await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return applied;
}

/**
 * Start a fresh Postgres container, wait for it to be ready, apply ALL forward
 * migrations from /migrations, and return a handle. The connection URI is the
 * canonical value the caller should write to `process.env.DATABASE_URL` BEFORE
 * dynamically importing any module that pulls in `@/db/client.js` (production
 * db pool captures the connection string at module load).
 *
 * The container is configured with:
 *  - database name `maia_test` (matches `tests/setup.ts` defaults so any code
 *    path that reads POSTGRES_DB sees a familiar name);
 *  - image `pgvector/pgvector:pg16` (matches docker-compose.yml; required by
 *    migration 001's `CREATE EXTENSION vector`).
 *
 * Throws with an actionable message if Docker isn't reachable.
 */
export async function startPostgresContainer(): Promise<StartedPostgres> {
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('maia_test')
      .withUsername('maia_test')
      .withPassword('test1234')
      .start();
  } catch (err) {
    throw new Error(
      [
        '',
        '┌─────────────────────────────────────────────────────────────────┐',
        '│  Failed to start Postgres testcontainer (Docker unreachable?).  │',
        '└─────────────────────────────────────────────────────────────────┘',
        '',
        'This test requires a running Docker daemon. Locally, ensure Docker',
        'Desktop is running. In CI, this test must run in a job with Docker',
        'enabled (the existing `integration` job uses service containers and',
        'does NOT provide a Docker daemon — testcontainer-based specs need a',
        'separate job).',
        '',
        `Underlying error: ${(err as Error).message}`,
        '',
      ].join('\n'),
      { cause: err },
    );
  }

  const uri = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: uri, max: 5 });

  try {
    await applyMigrations(pool);
  } catch (err) {
    // Migrations failed — clean up the container before re-throwing so the
    // test runner doesn't leak a zombie container after a hard failure.
    await pool.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw err;
  }

  return { container, uri, pool };
}

/**
 * Teardown helper. Closes the pool, then stops the container. Safe to call
 * multiple times — the underlying clients ignore double-shutdown.
 */
export async function stopPostgresContainer(handle: StartedPostgres): Promise<void> {
  await handle.pool.end().catch(() => undefined);
  await handle.container.stop().catch(() => undefined);
}

/**
 * Probe whether the Docker daemon is reachable BEFORE trying to start a
 * container. Uses testcontainers' own runtime-discovery helper so it honours
 * the same auto-detection (DOCKER_HOST env, default socket paths per OS,
 * Rancher Desktop, Colima, podman-socket, etc.) the start() call would use.
 *
 * Returns `true` when a usable container runtime was found; `false` when
 * Docker is unreachable. NEVER throws — failures fall through to `false` so
 * the caller can `describe.skip` cleanly. Cached for the lifetime of the
 * test process so repeated calls don't reprobe.
 *
 * Used to gate `describe(...)` vs `describe.skip(...)` so testcontainer
 * specs run on machines with Docker but cleanly skip on Docker-less runners.
 */
let _dockerProbed: boolean | undefined;
export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerProbed !== undefined) return _dockerProbed;
  // Hard opt-out (e.g. `vitest --watch` on a laptop without Docker).
  if (process.env.SKIP_DOCKER_TESTS === '1') {
    _dockerProbed = false;
    return false;
  }
  try {
    // testcontainers' runtime discovery is the single source of truth for
    // "can we actually start a container?". Importing it dynamically keeps
    // the cost off the import chain when the suite skips.
    const { getContainerRuntimeClient } = await import('testcontainers');
    await getContainerRuntimeClient();
    _dockerProbed = true;
  } catch {
    _dockerProbed = false;
  }
  return _dockerProbed;
}
