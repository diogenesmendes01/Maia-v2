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
 * Migration runner: since issue #516 this fixture calls the SHARED runner
 * (`src/migrations/runner.ts`) — the very code `npm run db:migrate` and the
 * one-shot deploy job run. It used to carry a hand-copied duplicate of the
 * apply loop "kept in sync" with the script by convention, which is exactly
 * the drift this issue removes: every real-DB spec in the suite now exercises
 * the production runner, so a runner bug fails the tests instead of hiding
 * behind a divergent test-only implementation.
 *
 * Why we set `DATABASE_URL` before importing `@/db/client.js`: production
 * `db` is constructed at module load from `config.DATABASE_URL` (pg.Pool
 * connection string is captured then). Tests that need to point the real
 * `db` at the testcontainer must mutate `process.env.DATABASE_URL` and then
 * dynamic-import the modules they exercise — never the other way around.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrateUp } from '@/migrations/runner.js';
import { silentMigrationLogger } from '@/migrations/log.js';

/**
 * Same image production uses (docker-compose.yml). pgvector is required by
 * migration 001 (`CREATE EXTENSION vector`); the upstream `postgres:16-alpine`
 * image would fail that step.
 */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

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
 * Apply the forward chain with the PRODUCTION runner (issue #516).
 *
 * Silent logger: a green suite must not emit ~120 JSON lines per container.
 * A failure is turned into a thrown Error with the migration id and the error
 * CLASS — the runner never surfaces a raw driver message (it could carry the
 * DSN), so neither does this.
 */
async function applyMigrations(pool: pg.Pool): Promise<number> {
  const result = await migrateUp({
    pool,
    migrationsDir: await findMigrationsDir(),
    logger: silentMigrationLogger,
  });
  switch (result.outcome) {
    case 'applied':
    case 'noop':
      return result.applied.length;
    case 'failed':
      throw new Error(
        `migration ${result.failed_id} failed (${result.error_class})` +
          `${result.dirty ? ' and left DIRTY state' : ''}`,
      );
    case 'blocked':
      throw new Error(
        `migration runner refused to start: ${result.problems.map((p) => `${p.code} (${p.id ?? '-'})`).join(', ')}`,
      );
    case 'lock_timeout':
      throw new Error('migration runner could not take the advisory lock in a fresh container');
  }
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
