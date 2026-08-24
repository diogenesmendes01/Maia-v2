/**
 * Issue #613 / ADR 0003 — which health-shaped endpoint carries a verdict.
 *
 * The regression this locks is not a crash, it is a category error: `/health`
 * answered 200 while its body said `"status":"down"`, `docs/admin-ui-deploy.md`
 * told operators to configure the `app` health check as `GET /health` → 200,
 * and the missing `reply.code` in the handler was indistinguishable from an
 * oversight. Whoever followed that guide had a check that never once fired.
 *
 * The decision (ADR 0003) is that `/health*` is DIAGNOSTIC and stays 200, and
 * that the split is stated on the wire. So this file pins BOTH directions:
 *
 *   - `/health` must NOT start reproving. `checkAll()` is role-blind and flat —
 *     `whatsapp: down` is the normal steady state of an `api`/`worker`/
 *     `scheduler` process — so a 503 there would drain correctly-healthy
 *     instances. Making the status conditional on `report.status` turns the
 *     first test red.
 *   - `/health` must keep SAYING it is diagnostic. Deleting `asDiagnostic(reply)`
 *     from the handler drops the `x-maia-endpoint-kind` header and turns the
 *     header test red; dropping `probe`/`probes` turns the marker test red.
 *   - `/livez`, `/startupz` and `/readyz` must keep carrying their verdicts in
 *     the status line, with the same dependencies down.
 *
 * Everything runs against the REAL `buildServer()` from `src/server.ts` — the
 * production call site, not a Fastify app that mirrors the handlers. A mirror
 * stays green when the real route is deleted; this does not.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const deps = vi.hoisted(() => ({
  db: true,
  redis: true,
  whatsapp: true,
  /** Every DB/Redis call the probes make, so `/livez` can be proven inert. */
  io: [] as string[],
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      deps.io.push('db.execute');
      if (!deps.db) throw new Error('connection refused');
      return [];
    }),
  },
  pool: { connect: vi.fn(), end: vi.fn() },
  isDbConnected: () => deps.db,
  probeDb: vi.fn(async () => {
    deps.io.push('probeDb');
    return deps.db;
  }),
}));

vi.mock('../../../src/lib/redis.js', () => ({
  redis: {
    ping: vi.fn(async () => {
      deps.io.push('redis.ping');
      if (!deps.redis) throw new Error('connection refused');
      return 'PONG';
    }),
    quit: vi.fn(),
    info: vi.fn(async () => ''),
  },
  isRedisConnected: () => deps.redis,
  ensureRedisConnect: vi.fn(async () => undefined),
}));

vi.mock('../../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => deps.whatsapp,
  getLastDisconnectAt: () => (deps.whatsapp ? undefined : new Date('2026-08-24T00:00:00.000Z')),
}));

vi.mock('../../../src/gateway/queue.js', () => ({
  agentQueue: { name: 'agent', getWaitingCount: vi.fn(async () => 0) },
  unroutedQueue: { name: 'unrouted-replay', getWaitingCount: vi.fn(async () => 0) },
}));

// The Redis-memory readiness input (#297). Kept fresh and unpressured so the
// only thing moving `/readyz` in this file is what each test moves.
vi.mock('../../../src/observability/redis-memory-collector.js', () => ({
  CRITICAL_MEMORY_USED_RATIO: 0.95,
  getMemoryUsedRatio: () => 0,
  isMemorySnapshotFresh: () => true,
  startRedisMemoryCollector: () => ({ stop: vi.fn() }),
}));

// Only the schema VERDICT is stubbed (#516 owns its own specs); the readiness
// gate around it stays real.
vi.mock('../../../src/runtime/lifecycle/schema-readiness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/runtime/lifecycle/schema-readiness.js')>();
  return {
    ...actual,
    checkSchemaReadiness: vi.fn(async () => ({ state: 'ready' as const })),
  };
});

// `/setup` is out of scope here and pulls the pairing state machine in.
vi.mock('../../../src/setup/index.js', () => ({
  registerSetupRoutes: vi.fn(async () => undefined),
}));

import { buildServer } from '../../../src/server.js';
import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import { LIFECYCLE_COMPONENTS } from '../../../src/runtime/lifecycle/roles.js';
import { _resetReadinessCacheForTests } from '../../../src/runtime/lifecycle/readiness.js';
import {
  _resetHealthCacheForTests,
  DIAGNOSTIC_ENDPOINT_HEADER,
  DIAGNOSTIC_ENDPOINT_KIND,
} from '../../../src/lib/healthcheck.js';

let app: FastifyInstance;

function everyDependencyDown(): void {
  deps.db = false;
  deps.redis = false;
  deps.whatsapp = false;
}

function everyDependencyUp(): void {
  deps.db = true;
  deps.redis = true;
  deps.whatsapp = true;
}

/** Bring the instance to the state a healthy boot leaves it in. */
function inRotation(): void {
  for (const c of LIFECYCLE_COMPONENTS) lifecycle.setComponent(c, 'ready');
  lifecycle.transitionTo('ready');
  _resetReadinessCacheForTests();
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  lifecycle._resetForTests();
  _resetReadinessCacheForTests();
  _resetHealthCacheForTests();
  everyDependencyUp();
  deps.io.length = 0;
});

describe('/health is a DIAGNOSTIC report — it never carries the verdict in the status', () => {
  it('answers 200 with `status: "down"` when every dependency is down', async () => {
    everyDependencyDown();

    const res = await app.inject({ method: 'GET', url: '/health' });

    // THE decision of ADR 0003. Making the handler's `reply.code` conditional
    // on `report.status` — i.e. implementing the rejected Option A — fails here.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.components.map((c: { component: string }) => c.component)).toEqual([
      'db',
      'redis',
      'whatsapp',
    ]);
  });

  it('answers 200 when everything is healthy too — the status line never moves', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('declares itself diagnostic in the response header, healthy or not', async () => {
    for (const down of [false, true]) {
      if (down) everyDependencyDown();
      else everyDependencyUp();
      _resetHealthCacheForTests();

      const res = await app.inject({ method: 'GET', url: '/health' });

      // Deleting `asDiagnostic(reply)` from the real handler fails here.
      expect(res.headers[DIAGNOSTIC_ENDPOINT_HEADER]).toBe(DIAGNOSTIC_ENDPOINT_KIND);
    }
  });

  it('names the probe endpoints in its own body, for whoever pointed a check here', async () => {
    everyDependencyDown();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();

    expect(body.probe).toBe(false);
    expect(body.probes).toEqual({
      liveness: '/livez',
      startup: '/startupz',
      readiness: '/readyz',
    });
  });

  it('marks the per-component endpoints diagnostic as well, and keeps them 200 when down', async () => {
    everyDependencyDown();

    for (const url of ['/health/db', '/health/redis', '/health/whatsapp']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers[DIAGNOSTIC_ENDPOINT_HEADER], url).toBe(DIAGNOSTIC_ENDPOINT_KIND);
      expect(res.json().status, url).toBe('down');
    }
  });

  it('still leaks no raw driver text while reporting a dead dependency (#512)', async () => {
    everyDependencyDown();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.body).not.toMatch(/"details"/);
    expect(res.body).not.toMatch(/connection refused/i);
  });
});

describe('the three probes DO carry the verdict in the status', () => {
  it('/livez is 200 with every dependency down, and performs no I/O at all', async () => {
    everyDependencyDown();

    const res = await app.inject({ method: 'GET', url: '/livez' });

    expect(res.statusCode).toBe(200);
    expect(res.json().live).toBe(true);
    // A liveness probe that touches a dependency turns an outage into a
    // restart loop (#512). Nothing above may have queried anything.
    expect(deps.io).toEqual([]);
  });

  it('/livez stays 200 while draining — liveness is not readiness', async () => {
    inRotation();
    lifecycle.transitionTo('draining', 'SIGTERM');
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('draining');
  });

  it('/startupz is 503 while starting and 200 once the lifecycle is ready', async () => {
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(503);
    inRotation();
    expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
  });

  it('/readyz is 503 with a required dependency down, and 200 when it is back', async () => {
    inRotation();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);

    deps.db = false;
    deps.redis = false;
    _resetReadinessCacheForTests();

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/required component\(s\) not healthy/);
  });

  it('/readyz is 503 immediately on drain', async () => {
    inRotation();
    lifecycle.transitionTo('draining', 'SIGTERM');
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/draining/i);
  });
});

describe('the distinction, in one instant', () => {
  it('with Postgres and Redis down: /health 200, /livez 200, /readyz 503', async () => {
    inRotation();
    deps.db = false;
    deps.redis = false;
    _resetReadinessCacheForTests();
    _resetHealthCacheForTests();

    const [health, livez, readyz] = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/livez' }),
      app.inject({ method: 'GET', url: '/readyz' }),
    ]);

    // The report says what is wrong, and says it with a 200 because the report
    // was produced. The routing gate says 503. The restart gate says 200,
    // because the process is fine — Postgres is not.
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('down');
    expect(livez.statusCode).toBe(200);
    expect(readyz.statusCode).toBe(503);
  });
});
