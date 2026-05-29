import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

const countOpenMock = vi.fn();
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue(undefined);
const redisSetMock = vi.fn();
const loggerError = vi.fn();
const loggerWarn = vi.fn();
const loggerDebug = vi.fn();
const loggerInfo = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  dlqRepo: { countOpen: countOpenMock },
}));

vi.mock('../../src/lib/alerts.js', () => ({
  sendAlert: sendAlertMock,
}));

vi.mock('../../src/governance/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/lib/redis.js', () => ({
  redis: { set: redisSetMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { error: loggerError, warn: loggerWarn, debug: loggerDebug, info: loggerInfo },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { DLQ_ALERT_THRESHOLD: 10 },
}));

beforeEach(() => {
  countOpenMock.mockReset();
  sendAlertMock.mockClear();
  auditMock.mockClear();
  redisSetMock.mockReset();
  loggerError.mockClear();
  loggerWarn.mockClear();
  loggerDebug.mockClear();
  loggerInfo.mockClear();
});

describe('dlq-monitor worker', () => {
  it('does not alert when count is below threshold', async () => {
    countOpenMock.mockResolvedValue(5);
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(countOpenMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('does not alert when count equals threshold (strict greater-than only)', async () => {
    countOpenMock.mockResolvedValue(10);
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('fires alert when count exceeds threshold and Redis flag was not set', async () => {
    countOpenMock.mockResolvedValue(42);
    redisSetMock.mockResolvedValue('OK'); // SET ... NX returns 'OK' on success
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(redisSetMock).toHaveBeenCalledTimes(1);
    // Verify NX + EX 1h call shape
    const call = redisSetMock.mock.calls[0]!;
    expect(call[0]).toBe('maia:dlq_monitor:alerted');
    expect(call).toContain('NX');
    expect(call).toContain('EX');
    const exIdx = call.indexOf('EX');
    expect(call[exIdx + 1]).toBe(60 * 60); // 1 hour TTL

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const arg = sendAlertMock.mock.calls[0]![0] as { subject: string; body: string };
    expect(arg.subject).toContain('42');
    expect(arg.subject).toContain('10');

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'dlq_alert_emitted',
        metadata: expect.objectContaining({ count: 42, threshold: 10 }),
      }),
    );

    // High-severity log line emitted with the dlq.threshold_exceeded tag.
    const errorTags = loggerError.mock.calls.map((c) => c[0]);
    expect(errorTags.some((t) => t && (t as { tag?: string }).tag === 'dlq.threshold_exceeded')).toBe(true);
  });

  it('does not re-alert when Redis flag is already set (throttled)', async () => {
    countOpenMock.mockResolvedValue(42);
    redisSetMock.mockResolvedValue(null); // SET NX returns null when key exists
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('still alerts when Redis itself fails (best-effort, fail-open)', async () => {
    countOpenMock.mockResolvedValue(42);
    redisSetMock.mockRejectedValue(new Error('redis down'));
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalled();
  });

  it('returns early without crashing when DLQ count query fails', async () => {
    countOpenMock.mockRejectedValue(new Error('db unreachable'));
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await expect(runDlqMonitor()).resolves.toBeUndefined();
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  // Issue #323 phase 2: the worker runs as GLOBAL maintenance under the
  // reserved `system` sentinel — NOT the legacy `default/default` literal that
  // MAIA_REJECT_DEFAULT_LITERAL is on track to reject. Capture the live ALS
  // context from inside the (mocked) repo call to prove the wrapper.
  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    countOpenMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return 0;
    });
    const { runDlqMonitor } = await import('../../src/workers/dlq-monitor.js');
    await runDlqMonitor();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});
