/**
 * Review 2 — Blocker 4: the outbox-drain worker must LOOP within one
 * cron firing to honour the per-second rate cadence. Without the loop,
 * a per-minute cron + per-second rate gate yields ~1 msg/minute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const drainResults: Array<{
  reclaimed: number;
  drained: number;
  sent: number;
  failed: number;
  rate_limited: number;
}> = [];
const runOutboxDrainMock = vi.fn(async () => {
  return drainResults.shift() ?? { reclaimed: 0, drained: 0, sent: 0, failed: 0, rate_limited: 0 };
});

vi.mock('../../src/scheduling/outbox-drain.js', () => ({
  runOutboxDrain: runOutboxDrainMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { OUTBOX_DRAIN_LOOP_PASSES: 5, OUTBOX_DRAIN_LOOP_SLEEP_MS: 0 },
}));

beforeEach(() => {
  drainResults.length = 0;
  runOutboxDrainMock.mockClear();
});

describe('outbox-drain worker loop — Blocker 4 (review 2)', () => {
  it('loops until the queue is empty within one cron firing', async () => {
    // Three passes: each sends 1, then queue empties.
    drainResults.push({ reclaimed: 0, drained: 1, sent: 1, failed: 0, rate_limited: 0 });
    drainResults.push({ reclaimed: 0, drained: 1, sent: 1, failed: 0, rate_limited: 0 });
    drainResults.push({ reclaimed: 0, drained: 0, sent: 0, failed: 0, rate_limited: 0 });

    const { runOutboxDrainWorker } = await import('../../src/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(runOutboxDrainMock).toHaveBeenCalledTimes(3);
  });

  it('exits early when first pass finds empty queue', async () => {
    drainResults.push({ reclaimed: 0, drained: 0, sent: 0, failed: 0, rate_limited: 0 });
    const { runOutboxDrainWorker } = await import('../../src/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(runOutboxDrainMock).toHaveBeenCalledTimes(1);
  });

  it('respects max passes when queue never empties (10k backlog scenario)', async () => {
    // Every pass sends 1, never empty.
    for (let i = 0; i < 100; i++) {
      drainResults.push({ reclaimed: 0, drained: 1, sent: 1, failed: 0, rate_limited: 0 });
    }
    const { runOutboxDrainWorker } = await import('../../src/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(runOutboxDrainMock).toHaveBeenCalledTimes(5); // capped at config 5
  });

  it('continues after rate_limited passes (would sleep in prod; 0ms in test)', async () => {
    drainResults.push({ reclaimed: 0, drained: 5, sent: 1, failed: 0, rate_limited: 4 });
    drainResults.push({ reclaimed: 0, drained: 4, sent: 1, failed: 0, rate_limited: 3 });
    drainResults.push({ reclaimed: 0, drained: 0, sent: 0, failed: 0, rate_limited: 0 });
    const { runOutboxDrainWorker } = await import('../../src/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(runOutboxDrainMock).toHaveBeenCalledTimes(3);
  });
});
