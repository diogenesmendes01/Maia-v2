/**
 * Issue #512 — lifecycle probes against REAL Postgres + Redis.
 *
 * Covers the acceptance criteria that cannot be proven with mocks:
 *   - `/health` performs NO writes (the row count of `system_health_events`
 *     is unchanged after a burst of polls);
 *   - `/livez` answers 200 with the database intentionally left out of the
 *     picture (no I/O at all);
 *   - `/startupz` and `/readyz` stay 503 until the lifecycle reaches `ready`,
 *     even though HTTP is already listening (the early-listener escape hatch
 *     in issue #512 §4 must never mean "in rotation");
 *   - `/readyz` returns 503 IMMEDIATELY when the drain starts;
 *   - the schema-version gate agrees with a fully migrated database.
 *
 * Skipped without TEST_DB_URL (mirrors the sibling integration specs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@/server.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { _resetReadinessCacheForTests } from '@/runtime/lifecycle/readiness.js';
import { checkSchemaVersion, _resetSchemaVersionCacheForTests } from '@/runtime/lifecycle/schema-version.js';
import { _resetHealthCacheForTests } from '@/lib/healthcheck.js';
import { ensureRedisConnect } from '@/lib/redis.js';
import { LIFECYCLE_COMPONENTS } from '@/runtime/lifecycle/roles.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let app: FastifyInstance;

async function healthRowCount(): Promise<number> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM system_health_events');
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** Bring every component to `ready` the way `src/index.ts` does at boot. */
function markAllComponentsReady(): void {
  for (const c of LIFECYCLE_COMPONENTS) lifecycle.setComponent(c, 'ready');
}

d('issue #512 — lifecycle probes (real deps)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureRedisConnect();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(() => {
    lifecycle._resetForTests();
    _resetReadinessCacheForTests();
    _resetHealthCacheForTests();
    _resetSchemaVersionCacheForTests();
  });

  it('/health writes NO rows, however hard it is polled', async () => {
    const before = await healthRowCount();
    for (let i = 0; i < 8; i++) {
      _resetHealthCacheForTests(); // defeat the cache so every poll really probes
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect([200]).toContain(res.statusCode);
    }
    // Give any (bug-introduced) fire-and-forget INSERT a chance to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await healthRowCount()).toBe(before);
  });

  it('/health never returns raw driver text', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.body;
    expect(body).not.toMatch(/"details"/);
    expect(body).not.toMatch(/password|ECONNREFUSED|postgres:\/\//i);
  });

  it('/livez is 200 while the lifecycle is still `starting` (no dependency)', async () => {
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json().live).toBe(true);
    expect(res.json().state).toBe('starting');
  });

  it('/startupz and /readyz are 503 while starting, even though HTTP listens', async () => {
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(503);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().reason).toMatch(/starting/i);
  });

  it('/readyz turns 200 once the lifecycle is ready and the real probes pass', async () => {
    markAllComponentsReady();
    lifecycle.transitionTo('ready');
    // The Redis memory snapshot needs one successful collect before the #297
    // gate stops failing closed; poll briefly rather than sleeping blindly.
    let status = 0;
    for (let i = 0; i < 40; i++) {
      _resetReadinessCacheForTests();
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      status = res.statusCode;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
  }, 20_000);

  it('/readyz drops to 503 IMMEDIATELY when the drain starts', async () => {
    markAllComponentsReady();
    lifecycle.transitionTo('ready');
    // No cache reset here on purpose: the state check must bypass the cache.
    lifecycle.transitionTo('draining', 'SIGTERM');
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/draining/i);
    // …and the startup probe stays positive so a slow drain is not killed.
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
  });

  it('the schema gate agrees with a fully migrated database', async () => {
    const r = await checkSchemaVersion();
    expect(r.status).toBe('ok');
    expect(r.applied).toBe(r.expected);
  });
});
