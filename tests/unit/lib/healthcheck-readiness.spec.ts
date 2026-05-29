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

const { ratioMock } = vi.hoisted(() => ({ ratioMock: vi.fn<[], number>() }));

vi.mock('../../../src/observability/redis-memory-collector.js', () => ({
  getMemoryUsedRatio: ratioMock,
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
  });

  it('is ready (200-worthy) when ratio is well below critical', async () => {
    ratioMock.mockReturnValue(0.5);
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.checks.redis_memory_used_ratio).toBe(0.5);
    expect(r.checks.redis_memory_critical_ratio).toBe(0.95);
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

  it('is ready when Redis is unbounded (ratio 0 → no cap configured)', async () => {
    // maxmemory=0 surfaces as ratio 0 from the collector; a missing cap must
    // never read as critical pressure.
    ratioMock.mockReturnValue(0);
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
  });
});

describe('/readyz route contract — HTTP status mirrors readiness', () => {
  beforeEach(() => {
    ratioMock.mockReset();
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
});
