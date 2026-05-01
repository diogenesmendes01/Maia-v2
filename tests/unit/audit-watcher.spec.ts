import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS } from '../../src/governance/audit-actions.js';

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
    expect(ids).toContain('pairing_recovery_stuck');
    expect(ids).toContain('llm_circuit_long_open');
    expect(ids).toContain('bot_volume_burst');
  });

  // Regression: a rule referencing a non-existent audit action would never
  // fire (born-dead). Assert every rule's `acao`/`mate_acao` is a registered
  // AuditAction so we can't merge a born-dead rule again.
  it('every rule references actions that exist in AUDIT_ACTIONS', async () => {
    const { _internal } = await import('../../src/workers/audit-watcher.js');
    const registry = new Set<string>(AUDIT_ACTIONS);
    for (const rule of _internal.RULES) {
      expect(registry.has(rule.acao), `acao "${rule.acao}" of rule "${rule.id}"`).toBe(true);
      if (rule.kind === 'stuck') {
        expect(
          registry.has(rule.mate_acao),
          `mate_acao "${rule.mate_acao}" of rule "${rule.id}"`,
        ).toBe(true);
      }
    }
  });

  // Regression: the original PR queried `FROM auditoria`, which doesn't exist
  // in the schema — the real table is `audit_log`. The watcher now interpolates
  // the imported `audit_log` schema reference. Render the SQL the watcher
  // hands to `db.execute` through Drizzle's PgDialect and assert the rendered
  // text references `audit_log` and never the legacy name.
  it('queries reference the audit_log table, not auditoria', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [{ c: 0 }] });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(dbExecuteMock).toHaveBeenCalled();

    const dialect = new PgDialect();
    for (const call of dbExecuteMock.mock.calls) {
      const rendered = dialect.sqlToQuery(call[0] as SQL).sql;
      expect(rendered).not.toMatch(/\bauditoria\b/);
      expect(rendered).toMatch(/\baudit_log\b/);
    }
  });
});
