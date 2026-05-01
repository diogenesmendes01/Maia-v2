import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const dbExecuteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({ db: { execute: dbExecuteMock } }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../../src/db/client.js', () => ({ db: { execute: dbExecuteMock } }));
  vi.doMock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
  vi.doMock('../../src/lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  sendAlertMock.mockClear();
  dbExecuteMock.mockReset();
});

describe('audit-watcher', () => {
  it('fires alert when threshold rule meets the count', async () => {
    // Every query returns 100 (well above all thresholds in the rule list).
    // The first rule in RULES (setup_unauthorized_farm, threshold 3) will trip.
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 100 }] });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(sendAlertMock).toHaveBeenCalled();
    const subjects = sendAlertMock.mock.calls.map((c) => c[0].subject as string);
    expect(subjects.some((s) => s.includes('setup_unauthorized_farm'))).toBe(true);
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(true);
  });

  it('does not fire when threshold rule is below count', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 0 }] });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('throttles repeat alerts within the 30-min window', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 100 }] });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    const firstCount = sendAlertMock.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    // Second tick same minute — throttle must suppress every alert.
    sendAlertMock.mockClear();
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 100 }] });
    await runAuditWatcher();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('survives a DB error in one rule and continues to the next', async () => {
    // First call (first rule) throws, subsequent calls succeed with 0 — only
    // the throwing rule should be skipped, others still run.
    dbExecuteMock.mockRejectedValueOnce(new Error('connection lost'));
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 0 }] });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await expect(runAuditWatcher()).resolves.toBeUndefined();
    // No alerts because subsequent rules return 0
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('exposes a stable RULES list for ops dashboards', async () => {
    const { _internal } = await import('../../src/workers/audit-watcher.js');
    const ids = _internal.RULES.map((r) => r.id);
    expect(ids).toContain('setup_unauthorized_farm');
    expect(ids).toContain('setup_csrf_attack');
    expect(ids).toContain('pairing_recovery_stuck');
    expect(ids).toContain('llm_circuit_long_open');
    expect(ids).toContain('bot_volume_burst');
  });
});
