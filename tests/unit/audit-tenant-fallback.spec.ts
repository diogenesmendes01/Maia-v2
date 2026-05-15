import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for PR #75 review finding #3 (Codex / Superpowers):
 *
 * Audit writes coming from setup/CSRF/baileys-pairing/startup/shutdown code
 * paths run OUTSIDE any `runWithTenantContext`. Before the fix, `auditRepo.write`
 * threw `MissingTenantContextError`, the `try/catch` in `audit()` swallowed it,
 * and the row was lost — invisible to the audit watcher.
 *
 * After the fix, `audit()` wraps the write in a synthetic `system` tenant
 * context. The write must succeed and `auditRepo.write` must see the `system`
 * tenant/agent on the call site's `getCurrentTenant()`.
 */

const { auditWriteMock, incCounterMock } = vi.hoisted(() => ({
  auditWriteMock: vi.fn(),
  incCounterMock: vi.fn(),
}));

vi.mock('../../src/db/repositories.js', () => ({
  auditRepo: { write: auditWriteMock },
}));
vi.mock('../../src/lib/metrics.js', () => ({
  incCounter: incCounterMock,
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { audit } from '../../src/governance/audit.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '../../src/db/tenant-context.js';

describe('audit() — tenant context fallback (PR #75 #3)', () => {
  beforeEach(() => {
    auditWriteMock.mockReset();
    incCounterMock.mockReset();
  });

  it('outside any runWithTenantContext, write happens under the system tenant', async () => {
    let observedTenant: string | null = null;
    let observedAgent: string | null = null;
    auditWriteMock.mockImplementation(async () => {
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
    });

    await audit({ acao: 'whatsapp_connected', metadata: {} });

    expect(auditWriteMock).toHaveBeenCalledTimes(1);
    expect(observedTenant).toBe('system');
    expect(observedAgent).toBe('system');
    expect(incCounterMock).toHaveBeenCalledWith(
      'maia_audit_events_total',
      expect.objectContaining({ action: 'whatsapp_connected' }),
    );
  });

  it('inside a tenant context, write uses the caller context (not system)', async () => {
    let observedTenant: string | null = null;
    auditWriteMock.mockImplementation(async () => {
      observedTenant = getCurrentTenant();
    });

    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      () => audit({ acao: 'transacao_criada', metadata: {} }),
    );

    expect(observedTenant).toBe('default');
    expect(auditWriteMock).toHaveBeenCalledTimes(1);
  });

  it('on write failure, error is logged and metric incremented but no throw', async () => {
    auditWriteMock.mockRejectedValue(new Error('db down'));
    // Must NOT throw — audit is best-effort observability.
    await expect(audit({ acao: 'whatsapp_connected' })).resolves.toBeUndefined();
    expect(incCounterMock).toHaveBeenCalledWith(
      'maia_audit_write_failed_total',
      expect.objectContaining({ action: 'whatsapp_connected' }),
    );
  });
});
