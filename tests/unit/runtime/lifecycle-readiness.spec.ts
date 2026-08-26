/**
 * Issue #512 — role-aware readiness (`/readyz`) and the startup probe.
 *
 * The regression this locks: before the composite gate, `/readyz` answered a
 * single Redis-memory question and therefore went 200 on an instance with no
 * database, no agent worker and no WhatsApp session. Readiness must now be
 * fail-closed over the components the CURRENT ROLE owns, and must flip to
 * not-ready the instant a drain starts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { probeDbMock, redisConnectedMock, pingMock, baileysConnectedMock, memoryReadinessMock, schemaMock } =
  vi.hoisted(() => ({
    probeDbMock: vi.fn<[], Promise<boolean>>(),
    redisConnectedMock: vi.fn<[], boolean>(),
    pingMock: vi.fn<[], Promise<string>>(),
    baileysConnectedMock: vi.fn<[], boolean>(),
    memoryReadinessMock: vi.fn(),
    schemaMock: vi.fn(),
  }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/client.js', () => ({
  probeDb: probeDbMock,
  // `schema-readiness.js` binds the application pool at import time; it is
  // never reached here because `checkSchemaReadiness` itself is stubbed.
  pool: { connect: vi.fn() },
}));
vi.mock('../../../src/lib/redis.js', () => ({
  isRedisConnected: redisConnectedMock,
  redis: { ping: pingMock },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  isBaileysConnected: baileysConnectedMock,
}));
vi.mock('../../../src/lib/healthcheck.js', () => ({ checkReadiness: memoryReadinessMock }));
// Only the VERDICT is stubbed. `describeSchemaReadiness` — the function that
// turns a verdict into the string the probe body carries — stays real, so the
// sanitization it performs is exercised by these tests too.
vi.mock('../../../src/runtime/lifecycle/schema-readiness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/runtime/lifecycle/schema-readiness.js')>();
  return { ...actual, checkSchemaReadiness: schemaMock };
});

import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import {
  checkRoleReadiness,
  checkStartup,
  _resetReadinessCacheForTests,
} from '../../../src/runtime/lifecycle/readiness.js';
import type { LifecycleComponent } from '../../../src/runtime/lifecycle/roles.js';
import type {
  MigrationCompatibilityManifest,
  SchemaBlocker,
  SchemaReadiness,
} from '../../../src/migrations/types.js';

const MANIFEST: MigrationCompatibilityManifest = {
  schema_manifest_version: 1,
  expected_head: '123_head.sql',
  min_supported_migration: '123_head.sql',
  max_supported_migration: null,
};

/** A `SchemaReadiness` verdict, shaped exactly like `src/migrations/` emits. */
function verdict(
  state: SchemaReadiness['state'],
  blockers: readonly SchemaBlocker[] = [],
): SchemaReadiness {
  return {
    ready: state === 'ready',
    state,
    reason: blockers[0]?.detail ?? null,
    blockers,
    manifest: MANIFEST,
    expected_head: MANIFEST.expected_head,
    applied_head: state === 'ready' ? MANIFEST.expected_head : null,
    pending_count: 0,
    dirty_count: 0,
    checked_at: '2026-08-10T00:00:00.000Z',
    status: null,
  };
}

/** Bring every component of the active role to `ready` with healthy probes. */
function makeEverythingHealthy(): void {
  probeDbMock.mockResolvedValue(true);
  redisConnectedMock.mockReturnValue(true);
  pingMock.mockResolvedValue('PONG');
  baileysConnectedMock.mockReturnValue(true);
  memoryReadinessMock.mockResolvedValue({ ready: true, checks: {} });
  schemaMock.mockResolvedValue(verdict('ready'));
  const all: LifecycleComponent[] = [
    'config',
    'db',
    'schema',
    'redis',
    'redis_memory',
    'queue',
    'agent_worker',
    'cron_scheduler',
    'whatsapp_session',
    'http',
  ];
  for (const c of all) lifecycle.setComponent(c, 'ready');
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle._resetForTests();
  _resetReadinessCacheForTests();
});

describe('checkRoleReadiness — lifecycle state gate', () => {
  it('is NOT ready while `starting`, without doing any I/O', async () => {
    makeEverythingHealthy();
    lifecycle._resetForTests(); // back to `starting`, components pending
    probeDbMock.mockClear();
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.state).toBe('starting');
    expect(r.reason).toMatch(/starting/i);
    // A starting instance must not probe dependencies just to say "not yet".
    expect(probeDbMock).not.toHaveBeenCalled();
  });

  it('is ready once the lifecycle is `ready` and every required component is ok', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.role).toBe('all');
  });

  it('flips to NOT ready IMMEDIATELY when draining — even with a warm cache', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
    expect((await checkRoleReadiness()).ready).toBe(true);
    // No cache reset: the state check runs before (and outside) the cache.
    lifecycle.transitionTo('draining', 'SIGTERM');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.state).toBe('draining');
    expect(r.reason).toMatch(/draining/i);
  });

  it('is NOT ready in `failed`', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('failed', 'redis unavailable');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/startup failed/i);
  });
});

describe('checkRoleReadiness — per-component fail-closed', () => {
  beforeEach(() => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
  });

  it('DB down keeps the instance out of rotation', async () => {
    probeDbMock.mockResolvedValue(false);
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/db=down/);
  });

  it('Redis disconnected keeps the instance out of rotation', async () => {
    redisConnectedMock.mockReturnValue(false);
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/redis=down/);
  });

  it('a Redis PING failure is down, and the raw driver text never reaches the body', async () => {
    pingMock.mockRejectedValue(new Error('READONLY You can not write against a read only replica'));
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    const redisCheck = r.checks.find((c) => c.component === 'redis')!;
    expect(redisCheck.status).toBe('down');
    expect(redisCheck.detail).toBe('ping failed');
    expect(JSON.stringify(r)).not.toMatch(/read only replica/);
  });

  it('a stale Redis memory snapshot still drains the instance (issue #297 gate preserved)', async () => {
    memoryReadinessMock.mockResolvedValue({
      ready: false,
      reason: 'redis memory snapshot unavailable',
      checks: {},
    });
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/redis_memory=down/);
  });

  // Issue #516 — the gate is now `getSchemaReadiness()`. Each blocker kind
  // below is a schema this build must NOT serve traffic against, and the old
  // `checkSchemaVersion()` (newest ledger id vs newest file on disk) saw NONE
  // of them except the last one.
  const BLOCKED_CASES: readonly { name: string; blocker: SchemaBlocker }[] = [
    {
      name: 'a DIRTY migration',
      blocker: {
        kind: 'dirty_migration',
        id: '120_backfill.sql',
        detail: 'migration "120_backfill.sql" is DIRTY: a no-transaction run failed midway.',
      },
    },
    {
      name: 'a CHECKSUM MISMATCH between the packaged file and the ledger',
      blocker: {
        kind: 'checksum_mismatch',
        id: '118_index.sql',
        detail:
          'migration "118_index.sql" was applied with checksum aaaaaaa but the packaged file hashes to bbbbbbb.',
      },
    },
    {
      name: 'a migration file this build does NOT ship',
      blocker: {
        kind: 'missing_file',
        id: '124_from_the_future.sql',
        detail:
          'the database applied "124_from_the_future.sql", which this build does not ship.',
      },
    },
    {
      name: 'a schema BELOW the minimum this build supports',
      blocker: {
        kind: 'schema_below_minimum',
        detail: 'schema is below the minimum this build supports (123_head.sql).',
      },
    },
    {
      name: 'a schema ABOVE the maximum this build supports',
      blocker: {
        kind: 'schema_above_maximum',
        detail: 'schema is ahead of the maximum this build supports (123_head.sql).',
      },
    },
  ];

  for (const { name, blocker } of BLOCKED_CASES) {
    it(`${name} keeps the instance out of rotation`, async () => {
      schemaMock.mockResolvedValue(verdict('blocked', [blocker]));
      const r = await checkRoleReadiness();
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/schema=down/);
      const schemaCheck = r.checks.find((c) => c.component === 'schema')!;
      expect(schemaCheck.detail).toContain(blocker.kind);
    });
  }

  it('an UNKNOWN schema verdict fails CLOSED — "could not read" is never "ready"', async () => {
    schemaMock.mockResolvedValue(
      verdict('unknown', [
        {
          kind: 'ledger_unavailable',
          detail: 'schema state could not be determined (ECONNREFUSED) — failing closed',
        },
      ]),
    );
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/schema=unknown/);
  });

  it('a schema probe that THROWS still fails closed (never a swallowed warning)', async () => {
    schemaMock.mockRejectedValue(new Error('boom'));
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/schema=unknown/);
  });

  it('the schema detail never leaks a DSN or driver text', async () => {
    schemaMock.mockResolvedValue(
      verdict('unknown', [
        { kind: 'ledger_unavailable', detail: 'schema state could not be determined (28P01) — failing closed' },
      ]),
    );
    const r = await checkRoleReadiness();
    const body = JSON.stringify(r);
    expect(body).not.toMatch(/postgres:\/\//);
    expect(body).not.toMatch(/password/i);
  });

  it('a not-yet-started agent worker keeps the instance out of rotation', async () => {
    lifecycle.setComponent('agent_worker', 'pending');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/agent_worker=unknown/);
  });

  it('a not-yet-started cron scheduler keeps the instance out of rotation', async () => {
    lifecycle.setComponent('cron_scheduler', 'pending');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/cron_scheduler=unknown/);
  });
});

describe('checkRoleReadiness — WhatsApp: channel capacity vs API capacity', () => {
  beforeEach(() => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
  });

  it('a session that was NEVER established keeps the instance out of rotation', async () => {
    lifecycle.setComponent('whatsapp_session', 'pending');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/whatsapp_session=unknown/);
  });

  it('a transient reconnect degrades but does NOT drain (anti-flapping policy)', async () => {
    baileysConnectedMock.mockReturnValue(false);
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
    const wa = r.checks.find((c) => c.component === 'whatsapp_session')!;
    expect(wa.status).toBe('degraded');
    expect(wa.detail).toMatch(/reconnect/i);
  });
});

describe('checkRoleReadiness — role awareness', () => {
  it('a worker-only process is NOT gated on HTTP or WhatsApp', async () => {
    makeEverythingHealthy();
    lifecycle.setRole('worker');
    lifecycle.setComponent('http', 'pending');
    lifecycle.setComponent('whatsapp_session', 'pending');
    lifecycle.transitionTo('ready');
    const r = await checkRoleReadiness();
    expect(r.role).toBe('worker');
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.component)).not.toContain('http');
  });

  it('an api-only process is NOT gated on the agent worker or the cron scheduler', async () => {
    makeEverythingHealthy();
    lifecycle.setRole('api');
    lifecycle.setComponent('agent_worker', 'pending');
    lifecycle.setComponent('cron_scheduler', 'pending');
    lifecycle.transitionTo('ready');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
  });

  it('an api-only process IS gated on the DB it queries', async () => {
    makeEverythingHealthy();
    lifecycle.setRole('api');
    lifecycle.transitionTo('ready');
    probeDbMock.mockResolvedValue(false);
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
  });

  it('marks exactly the role-required components as `required`', async () => {
    makeEverythingHealthy();
    lifecycle.setRole('scheduler');
    lifecycle.transitionTo('ready');
    const r = await checkRoleReadiness();
    const required = r.checks.filter((c) => c.required).map((c) => c.component).sort();
    expect(required).toEqual(
      ['config', 'cron_scheduler', 'db', 'redis', 'redis_memory', 'schema'].sort(),
    );
  });
});

describe('checkRoleReadiness — probes are cheap and bounded', () => {
  it('memoizes the component evaluation across rapid polls', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
    await checkRoleReadiness();
    await checkRoleReadiness();
    await checkRoleReadiness();
    // One evaluation, not three — an aggressive LB poll must not become load.
    expect(probeDbMock).toHaveBeenCalledTimes(1);
  });

  it('RESAMPLES the state after the probes: draining mid-probe still answers not-ready', async () => {
    // Review round 1, P2 (`readiness.ts:275`): the state was sampled BEFORE the
    // probes and never re-checked, so a SIGTERM landing while a probe was in
    // flight produced a `ready: true` built from a pre-drain snapshot. That is
    // exactly the request a rolling deploy generates.
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');

    let releaseProbe!: () => void;
    probeDbMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseProbe = () => resolve(true);
      }),
    );

    const inFlight = checkRoleReadiness();
    // …the drain starts while the DB probe is still pending.
    await new Promise((r) => setTimeout(r, 10));
    lifecycle.transitionTo('draining', 'SIGTERM');
    releaseProbe();

    const r = await inFlight;
    expect(r.ready).toBe(false);
    expect(r.state).toBe('draining');
    expect(r.reason).toMatch(/draining/i);
  });

  it('resamples for `failed` mid-probe too', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
    let releaseProbe!: () => void;
    probeDbMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseProbe = () => resolve(true);
      }),
    );
    const inFlight = checkRoleReadiness();
    await new Promise((r) => setTimeout(r, 10));
    lifecycle.transitionTo('failed', 'dependency lost');
    releaseProbe();
    const r = await inFlight;
    expect(r.ready).toBe(false);
    expect(r.state).toBe('failed');
  });

  it('a component that never answers is reported `unknown` (fail-closed for required)', async () => {
    makeEverythingHealthy();
    lifecycle.transitionTo('ready');
    probeDbMock.mockReturnValue(new Promise<boolean>(() => undefined));
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    const dbCheck = r.checks.find((c) => c.component === 'db')!;
    expect(dbCheck.status).toBe('unknown');
    expect(dbCheck.detail).toMatch(/timed out/i);
  }, 10_000);
});

describe('checkStartup — startup probe', () => {
  it('is negative while initializing and lists what is missing', () => {
    lifecycle.setRole('worker');
    const r = checkStartup();
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/initialization/i);
    expect(r.missing).toContain('agent_worker');
  });

  it('is positive once the lifecycle reached ready', () => {
    lifecycle.transitionTo('ready');
    expect(checkStartup().started).toBe(true);
  });

  it('STAYS positive while draining — a slow drain must not be killed as a failed startup', () => {
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining');
    expect(checkStartup().started).toBe(true);
  });

  it('is negative on a failed startup', () => {
    lifecycle.transitionTo('failed', 'redis unavailable');
    const r = checkStartup();
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/startup failed/i);
  });
});

describe('probe route contract — HTTP status codes the load balancer relies on', () => {
  async function buildProbeApp() {
    const app = Fastify({ logger: false });
    app.get('/livez', async (_req, reply) => {
      const snap = lifecycle.snapshot();
      reply.code(200);
      return { live: true, state: snap.state };
    });
    app.get('/startupz', async (_req, reply) => {
      const report = checkStartup();
      reply.code(report.started ? 200 : 503);
      return report;
    });
    app.get('/readyz', async (_req, reply) => {
      const report = await checkRoleReadiness();
      reply.code(report.ready ? 200 : 503);
      return report;
    });
    await app.ready();
    return app;
  }

  it('/livez is 200 in every lifecycle state (no dependency, no I/O)', async () => {
    const app = await buildProbeApp();
    try {
      probeDbMock.mockRejectedValue(new Error('db is gone'));
      for (const move of ['ready', 'draining', 'stopped'] as const) {
        const res = await app.inject({ method: 'GET', url: '/livez' });
        expect(res.statusCode).toBe(200);
        lifecycle.transitionTo(move);
      }
      expect(probeDbMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('/startupz is 503 while starting and 200 once ready', async () => {
    const app = await buildProbeApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(503);
      makeEverythingHealthy();
      lifecycle.transitionTo('ready');
      expect((await app.inject({ method: 'GET', url: '/startupz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('/readyz is 503 while starting, 200 when ready, 503 again on drain', async () => {
    const app = await buildProbeApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      makeEverythingHealthy();
      lifecycle.transitionTo('ready');
      _resetReadinessCacheForTests();
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      lifecycle.transitionTo('draining', 'SIGTERM');
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().reason).toMatch(/draining/i);
    } finally {
      await app.close();
    }
  });
});
