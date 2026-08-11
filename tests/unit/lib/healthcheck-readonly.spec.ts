/**
 * Issue #512 — health probes are READ-ONLY and do not leak driver internals.
 *
 * `checkAll()` used to fire three `healthRepo.record()` INSERTs on EVERY call.
 * `/health` is polled by the container healthcheck (compose.prod.yml every
 * few seconds) and by load balancers, so a probe endpoint grew
 * `system_health_events` forever and added write pressure to the database
 * during exactly the incidents it was meant to observe. The timeline now
 * belongs to the `health_monitor` cron worker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, pingMock, recordMock, connectedMock, baileysMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  pingMock: vi.fn(),
  recordMock: vi.fn(async () => undefined),
  connectedMock: vi.fn(() => true),
  baileysMock: vi.fn(() => true),
}));

vi.mock('../../../src/db/client.js', () => ({
  db: { execute: executeMock },
  pool: { end: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/lib/redis.js', () => ({
  redis: { ping: pingMock, quit: vi.fn(async () => undefined) },
  isRedisConnected: connectedMock,
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  isBaileysConnected: baileysMock,
  getLastDisconnectAt: () => null,
}));
vi.mock('../../../src/db/repositories.js', () => ({ healthRepo: { record: recordMock } }));
vi.mock('../../../src/observability/redis-memory-collector.js', () => ({
  getMemoryUsedRatio: () => 0.1,
  isMemorySnapshotFresh: () => true,
  CRITICAL_MEMORY_USED_RATIO: 0.95,
}));

import {
  checkAll,
  checkDb,
  recordHealthSnapshot,
  toPublicHealthReport,
  _resetHealthCacheForTests,
} from '../../../src/lib/healthcheck.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetHealthCacheForTests();
  executeMock.mockResolvedValue(undefined);
  pingMock.mockResolvedValue('PONG');
  connectedMock.mockReturnValue(true);
  baileysMock.mockReturnValue(true);
});

describe('checkAll — no writes', () => {
  it('writes NO health rows (a probe must not grow data)', async () => {
    const r = await checkAll();
    expect(r.status).toBe('ok');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('writes no rows even when components are down', async () => {
    executeMock.mockRejectedValue(new Error('connection terminated'));
    connectedMock.mockReturnValue(false);
    const r = await checkAll();
    expect(r.status).toBe('down');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('caches the result so a poll storm collapses into one round-trip', async () => {
    await checkAll();
    await checkAll();
    await checkAll();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(pingMock).toHaveBeenCalledTimes(1);
  });
});

describe('recordHealthSnapshot — persistence lives with the worker', () => {
  it('writes one row per component when the cron worker asks for it', async () => {
    const r = await checkAll();
    await recordHealthSnapshot(r.components);
    expect(recordMock).toHaveBeenCalledTimes(r.components.length);
  });

  it('never throws when the repository write fails (best-effort timeline)', async () => {
    recordMock.mockRejectedValueOnce(new Error('db gone'));
    const r = await checkAll();
    await expect(recordHealthSnapshot(r.components)).resolves.toBeUndefined();
  });
});

describe('toPublicHealthReport — no raw driver text on a public endpoint', () => {
  it('strips `details`, which carries the raw pg/ioredis message', async () => {
    executeMock.mockRejectedValue(
      new Error('connection to server at "10.0.0.7", port 5432 failed: password authentication'),
    );
    const raw = await checkDb();
    expect(raw.details).toBeDefined();
    const publicView = toPublicHealthReport(raw);
    expect(publicView).not.toHaveProperty('details');
    expect(JSON.stringify(publicView)).not.toMatch(/password authentication/);
    // The useful, non-sensitive signal survives.
    expect(publicView.component).toBe('db');
    expect(publicView.status).toBe('down');
  });
});
