import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

// health_monitor worker (issue #323 phase 2). `checkAll()` is non-DB and
// `healthRepo.record` is a bare INSERT that never reads the ALS context, so the
// worker is GENUINELY GLOBAL and was re-homed from the legacy `default/default`
// literal to the reserved `system` sentinel. These tests mock the collaborators
// and capture the live ALS context (inside the mocked `checkAll`, which runs
// inside the wrapper) to prove the wrapper.

const checkAllMock = vi.fn();
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const recordMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lib/healthcheck.js', () => ({ checkAll: checkAllMock }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/db/repositories.js', () => ({ healthRepo: { record: recordMock } }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  checkAllMock.mockReset();
  sendAlertMock.mockClear();
  recordMock.mockClear();
});

describe('health-monitor worker', () => {
  it('checks all components without alerting when everything is ok', async () => {
    checkAllMock.mockResolvedValue({ components: [{ component: 'db', status: 'ok' }] });
    const { runHealthMonitor } = await import('../../src/workers/health-monitor.js');
    await runHealthMonitor();

    expect(checkAllMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    checkAllMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return { components: [] };
    });
    const { runHealthMonitor } = await import('../../src/workers/health-monitor.js');
    await runHealthMonitor();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});
