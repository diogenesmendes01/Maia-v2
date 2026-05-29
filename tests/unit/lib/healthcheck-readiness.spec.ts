/**
 * Issue #297 — readiness gate (`/readyz`) memory-pressure threshold.
 *
 * `checkReadiness()` must report NOT-ready once Redis `memory_used_ratio`
 * crosses the critical threshold (> 0.95) so the load balancer drains the
 * instance before `noeviction` turns memory pressure into write failures.
 *
 * We mock the collector so the ratio is driven directly (no Redis round-trip
 * inside the gate is the whole point) and stub the other healthcheck deps
 * that import at module load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { ratioMock, freshMock } = vi.hoisted(() => ({
  ratioMock: vi.fn<[], number>(),
  freshMock: vi.fn<[], boolean>(),
}));

vi.mock('../../../src/observability/redis-memory-collector.js', () => ({
  getMemoryUsedRatio: ratioMock,
  isMemorySnapshotFresh: freshMock,
  CRITICAL_MEMORY_USED_RATIO: 0.95,
}));

// Healthcheck imports these at module load; stub to no-ops so importing the
// module under test never touches a real DB/Redis/Baileys.
vi.mock('../../../src/db/client.js', () => ({
  db: { execute: vi.fn() },
  pool: { end: vi.fn() },
}));
vi.mock('../../../src/lib/redis.js', () => ({
  redis: { ping: vi.fn(), quit: vi.fn() },
  isRedisConnected: () => true,
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => true,
  getLastDisconnectAt: () => undefined,
}));
vi.mock('../../../src/db/repositories.js', () => ({
  healthRepo: { record: vi.fn() },
}));

import { checkReadiness } from '../../../src/lib/healthcheck.js';

describe('checkReadiness — Redis memory-pressure gate', () => {
  beforeEach(() => {
    ratioMock.mockReset();
    freshMock.mockReset();
    // Default: a fresh snapshot exists. The cases in this block exercise the
    // ratio threshold; cold-start / stale (fail-closed) cases live below.
    freshMock.mockReturnValue(true);
  });

  it('is ready (200-worthy) when ratio is well below critical', async () => {
    ratioMock.mockReturnValue(0.5);
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.checks.redis_memory_used_ratio).toBe(0.5);
    expect(r.checks.redis_memory_critical_ratio).toBe(0.95);
    expect(r.checks.redis_memory_snapshot_fresh).toBe(true);
  });

  it('is ready exactly AT the threshold (0.95 is not yet > 0.95)', async () => {
    ratioMock.mockReturnValue(0.95);
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
  });

  it('is NOT ready (503-worthy) once ratio crosses > 0.95', async () => {
    ratioMock.mockReturnValue(0.96);
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/memory pressure critical/i);
    expect(r.reason).toContain('0.96');
    expect(r.checks.redis_memory_used_ratio).toBe(0.96);
  });

  it('is NOT ready at extreme pressure (ratio ~1.0)', async () => {
    ratioMock.mockReturnValue(0.999);
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
  });

  it('is ready when Redis is unbounded and freshly read (ratio 0 → no cap)', async () => {
    // A genuine, fresh maxmemory=0 reading surfaces as ratio 0; a missing cap
    // must never read as critical pressure — and because the snapshot is fresh
    // (a real collect happened), the fail-closed gate does NOT trip either.
    ratioMock.mockReturnValue(0);
    freshMock.mockReturnValue(true);
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.checks.redis_memory_snapshot_fresh).toBe(true);
  });
});

describe('checkReadiness — fail-closed on missing/stale snapshot', () => {
  beforeEach(() => {
    ratioMock.mockReset();
    freshMock.mockReset();
  });

  it('is NOT ready on cold start before any successful collect (ratio 0, not fresh)', async () => {
    // The collector snapshot is zero-initialized; ratio reads 0 but that 0 is
    // a placeholder, NOT a real "unbounded" reading. The gate must fail closed
    // so the LB does not route traffic before memory pressure is known.
    ratioMock.mockReturnValue(0);
    freshMock.mockReturnValue(false);
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/snapshot unavailable|failing closed|no fresh/i);
    expect(r.checks.redis_memory_snapshot_fresh).toBe(false);
  });

  it('is NOT ready when the snapshot is stale (collector wedged / Redis down)', async () => {
    // Even if the last cached ratio looked safe, a stale snapshot means the
    // collector stopped producing fresh data — treat the ratio as unknown.
    ratioMock.mockReturnValue(0.4);
    freshMock.mockReturnValue(false);
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/snapshot unavailable|failing closed|no fresh/i);
    expect(r.checks.redis_memory_snapshot_fresh).toBe(false);
  });

  it('fail-closed reason takes precedence over the critical-ratio reason', async () => {
    // If somehow both conditions hold, the unknown-snapshot reason wins (we
    // can't trust the ratio enough to label it "critical pressure").
    ratioMock.mockReturnValue(0.99);
    freshMock.mockReturnValue(false);
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).not.toMatch(/pressure critical/i);
    expect(r.reason).toMatch(/snapshot unavailable|failing closed|no fresh/i);
  });
});

describe('/readyz route contract — HTTP status mirrors readiness', () => {
  beforeEach(() => {
    ratioMock.mockReset();
    freshMock.mockReset();
    // Default to a fresh snapshot; the cold-start 503 case overrides below.
    freshMock.mockReturnValue(true);
  });

  /**
   * Wire `/readyz` exactly as `src/server.ts` does (200 on ready, 503 on
   * not-ready) without booting the full server graph. This locks the
   * status-code contract the load balancer relies on.
   */
  async function buildReadyzApp() {
    const app = Fastify({ logger: false });
    app.get('/readyz', async (_req, reply) => {
      const report = await checkReadiness();
      reply.code(report.ready ? 200 : 503);
      return report;
    });
    await app.ready();
    return app;
  }

  it('returns 200 when memory pressure is below critical', async () => {
    ratioMock.mockReturnValue(0.5);
    const app = await buildReadyzApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ready).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when memory pressure exceeds critical (LB drains instance)', async () => {
    ratioMock.mockReturnValue(0.97);
    const app = await buildReadyzApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().ready).toBe(false);
      expect(res.json().reason).toMatch(/memory pressure critical/i);
    } finally {
      await app.close();
    }
  });

  it('returns 503 on cold start before any successful collect (fail-closed)', async () => {
    // Snapshot not yet populated: fail closed so the LB does not route here
    // until the collector confirms Redis memory pressure is below critical.
    ratioMock.mockReturnValue(0);
    freshMock.mockReturnValue(false);
    const app = await buildReadyzApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().ready).toBe(false);
      expect(res.json().checks.redis_memory_snapshot_fresh).toBe(false);
    } finally {
      await app.close();
    }
  });
});
