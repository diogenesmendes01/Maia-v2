import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

// cost_monitor worker (flip-readiness #345 / #323). Re-homed off the legacy
// `default/default` literal to the reserved `system` sentinel
// (`runWithSystemContext`), mirroring the sibling global maintenance workers
// (health-monitor / idempotency-cleanup / dlq-monitor). These tests mock the
// collaborators and capture the live ALS context (inside the mocked
// `readDailyLLMUsd`, which runs inside the wrapper) to prove the wrapper.

const readDailyLLMUsdMock = vi.fn();
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const loggerInfo = vi.fn();

vi.mock('../../src/lib/cost-ledger.js', () => ({
  readDailyLLMUsd: readDailyLLMUsdMock,
}));

vi.mock('../../src/lib/alerts.js', () => ({
  sendAlert: sendAlertMock,
}));

vi.mock('../../src/config/env.js', () => ({
  config: { DAILY_LLM_USD_THRESHOLD: 5 },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  readDailyLLMUsdMock.mockReset();
  sendAlertMock.mockClear();
  loggerInfo.mockClear();
});

describe('cost-monitor worker', () => {
  it('reads yesterday and stays quiet when spend is at/below threshold', async () => {
    readDailyLLMUsdMock.mockResolvedValue(4.2);
    const { runCostMonitor } = await import('../../src/workers/cost-monitor.js');
    await runCostMonitor();

    expect(readDailyLLMUsdMock).toHaveBeenCalledTimes(1);
    // Reads yesterday's UTC date (records keyed by UTC day; prior day is closed
    // by the 02:30 BRT cron tick).
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(readDailyLLMUsdMock).toHaveBeenCalledWith(yesterday);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ day: yesterday, usd: 4.2, threshold: 5 }),
      'cost_monitor.tick',
    );
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('alerts when yesterday spend exceeds the threshold', async () => {
    readDailyLLMUsdMock.mockResolvedValue(9.99);
    const { runCostMonitor } = await import('../../src/workers/cost-monitor.js');
    await runCostMonitor();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('9.99'),
      }),
    );
  });

  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    readDailyLLMUsdMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return 0;
    });
    const { runCostMonitor } = await import('../../src/workers/cost-monitor.js');
    await runCostMonitor();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });

  it('does not throw under MAIA_REJECT_DEFAULT_LITERAL (system sentinel is allowed post-flip)', async () => {
    const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    try {
      // Exercise the real ALS read-time guards (getCurrentTenant/getCurrentAgent)
      // from inside the wrapper: under `system` they must NOT throw
      // DefaultLiteralRejectedError, proving the worker is flip-safe.
      const { getCurrentTenant, getCurrentAgent } = await import(
        '../../src/db/tenant-context.js'
      );
      let tenant: string | undefined;
      let agent: string | undefined;
      readDailyLLMUsdMock.mockImplementation(async () => {
        tenant = getCurrentTenant();
        agent = getCurrentAgent();
        return 0;
      });
      const { runCostMonitor } = await import('../../src/workers/cost-monitor.js');
      await expect(runCostMonitor()).resolves.toBeUndefined();
      expect(tenant).toBe('system');
      expect(agent).toBe('system');
    } finally {
      if (prev === undefined) delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      else process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    }
  });
});
