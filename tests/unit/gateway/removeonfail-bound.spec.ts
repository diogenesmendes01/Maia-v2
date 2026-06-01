/**
 * Issue #349 — bound BullMQ failed-job retention on the DEBOUNCED enqueue.
 *
 * Contract proven here:
 *   Working-memory keys carry a TTL, but BullMQ jobs historically did not —
 *   `removeOnComplete` was configured while `removeOnFail` was NOT, so failed
 *   jobs accumulated in Redis until manual intervention (DLQ pile vs.
 *   working-memory leak confusion in an incident). The debounced producer
 *   (`agentQueue.add` in `scheduleDebouncedAgent`, `src/gateway/debouncer.ts`)
 *   now caps failed-job retention with a GENEROUS bound
 *   (`{ count: 1000, age: 7d }`) that ages failed jobs out while keeping enough
 *   for DLQ inspection.
 *
 *   `removeOnComplete` is asserted alongside as the existing baseline, so a
 *   regression that drops EITHER bound fails loudly.
 *
 *   (The consumer-side Worker bound is proven separately in
 *   `worker-removeonfail-bound.spec.ts` — that seam needs the REAL `queue.ts`
 *   module with BullMQ stubbed, which is mutually exclusive with mocking
 *   `@/gateway/queue.js` here for the debouncer.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const EXPECTED_REMOVE_ON_FAIL = { count: 1000, age: 7 * 24 * 3600 };
const EXPECTED_REMOVE_ON_COMPLETE = { age: 86_400 };

// The debouncer composes the scoped jobId from the ALS tenant context, then
// calls `agentQueue.getJob` (no prior job) and `agentQueue.add` once. Mock the
// queue module so we can inspect the opts handed to `.add(...)` without a
// broker. No prior state → `readState` GET returns null (fresh first message).
const { queueAdd, queueGetJob, redisGet } = vi.hoisted(() => ({
  queueAdd: vi.fn(async () => undefined),
  queueGetJob: vi.fn(async () => null as { remove: () => Promise<void> } | null),
  redisGet: vi.fn(async () => null),
}));

vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: queueAdd, getJob: queueGetJob },
}));

vi.mock('@/lib/redis.js', () => ({
  redis: { get: redisGet, set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) },
  isRedisConnected: () => true,
  isRedisOomError: () => false,
  recordRedisOomDegraded: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/test',
    REDIS_URL: 'redis://localhost:6379',
    MESSAGE_DEBOUNCE_MS: 5000,
    MESSAGE_DEBOUNCE_MAX_MS: 30000,
  },
}));

const { scheduleDebouncedAgent } = await import('@/gateway/debouncer.js');
const { runWithTenantContext } = await import('@/db/tenant-context.js');

beforeEach(() => {
  queueAdd.mockReset();
  queueAdd.mockResolvedValue(undefined);
  queueGetJob.mockReset();
  queueGetJob.mockResolvedValue(null);
  redisGet.mockReset();
  redisGet.mockResolvedValue(null);
});

describe('debouncer agentQueue.add — bounded failed-job retention (#349)', () => {
  it('passes removeOnFail with the generous { count: 1000, age: 7d } bound', async () => {
    await runWithTenantContext({ tenant_id: 't1', agent_id: 'a1' }, async () => {
      await scheduleDebouncedAgent({ phone: '+5511999999999', mensagem_id: 'm1' });
    });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const opts = queueAdd.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.removeOnFail).toEqual(EXPECTED_REMOVE_ON_FAIL);
  });

  it('keeps removeOnComplete alongside removeOnFail (no bound dropped)', async () => {
    await runWithTenantContext({ tenant_id: 't1', agent_id: 'a1' }, async () => {
      await scheduleDebouncedAgent({ phone: '+5511999999999', mensagem_id: 'm1' });
    });

    const opts = queueAdd.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.removeOnComplete).toEqual(EXPECTED_REMOVE_ON_COMPLETE);
    expect(opts.removeOnFail).toEqual(EXPECTED_REMOVE_ON_FAIL);
  });
});
