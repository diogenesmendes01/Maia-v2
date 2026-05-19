/**
 * Fail-fast pre-checks for integration tests.
 *
 * Call `assertIntegrationDeps()` in a `beforeAll` at the top of any
 * integration spec that requires a live Postgres or Redis. The check
 * completes in ≤1 s and throws with an actionable message rather than
 * letting the spec hang for several seconds before ECONNREFUSED.
 *
 * Usage:
 *
 *   import { assertIntegrationDeps } from '../helpers/integrationSetup.js';
 *   beforeAll(async () => { await assertIntegrationDeps(); });
 *
 * The function is a no-op when `TEST_DB_URL` is unset — the caller is
 * expected to skip the suite in that case, matching the existing pattern:
 *
 *   const SHOULD_RUN = !!process.env.TEST_DB_URL;
 *   const d = SHOULD_RUN ? describe : describe.skip;
 */

import net from 'node:net';

interface ReachabilityTarget {
  host: string;
  port: number;
  label: string;
  setupScript: string;
}

/**
 * Attempt a raw TCP connect to `host:port` within `timeoutMs`.
 * Resolves `true` on success, `false` on any error or timeout.
 */
function tcpReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Parse `host:port` from a URL string, returning defaults on failure. */
function parseHostPort(url: string, defaultHost: string, defaultPort: number): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || defaultHost,
      port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
    };
  } catch {
    return { host: defaultHost, port: defaultPort };
  }
}

/**
 * Assert that all integration-test infrastructure is reachable.
 * Throws immediately with an actionable message if any dependency is down.
 *
 * @param opts - Override which services to check (default: both Postgres and Redis).
 */
export async function assertIntegrationDeps(
  opts: { postgres?: boolean; redis?: boolean } = { postgres: true, redis: true },
): Promise<void> {
  const targets: ReachabilityTarget[] = [];

  if (opts.postgres !== false) {
    const dbUrl = process.env.TEST_DB_URL ?? process.env.DATABASE_URL ?? '';
    const { host, port } = parseHostPort(dbUrl, 'localhost', 5432);
    targets.push({
      host,
      port,
      label: `Postgres (${host}:${port})`,
      setupScript: "npm run test:integration:setup",
    });
  }

  if (opts.redis !== false) {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const { host, port } = parseHostPort(redisUrl, 'localhost', 6379);
    targets.push({
      host,
      port,
      label: `Redis (${host}:${port})`,
      setupScript: "npm run test:integration:setup",
    });
  }

  const unreachable: ReachabilityTarget[] = [];
  await Promise.all(
    targets.map(async (t) => {
      const ok = await tcpReachable(t.host, t.port);
      if (!ok) unreachable.push(t);
    }),
  );

  if (unreachable.length > 0) {
    const services = unreachable.map((t) => `  - ${t.label}`).join('\n');
    throw new Error(
      [
        '',
        '┌─────────────────────────────────────────────────────────────────┐',
        '│  Integration test pre-check failed — service(s) not reachable:  │',
        '└─────────────────────────────────────────────────────────────────┘',
        '',
        services,
        '',
        'Start the required services with:',
        '',
        `  npm run test:integration:setup`,
        '',
        'Then re-run:',
        '',
        '  npm run test:integration',
        '',
        'To stop the services when done:',
        '',
        '  npm run test:integration:teardown',
        '',
      ].join('\n'),
    );
  }
}

/**
 * Convenience wrapper: assert Redis reachability only.
 * Use in specs that mock Postgres but hit a real Redis/BullMQ queue.
 */
export async function assertRedisReachable(): Promise<void> {
  return assertIntegrationDeps({ postgres: false, redis: true });
}

/**
 * Convenience wrapper: assert Postgres reachability only.
 * Use in specs that mock Redis but hit a real database.
 */
export async function assertPostgresReachable(): Promise<void> {
  return assertIntegrationDeps({ postgres: true, redis: false });
}
