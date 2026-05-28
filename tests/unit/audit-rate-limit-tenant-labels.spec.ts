import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for issue #271 (Codex revalidation of PR #258):
 *
 * Rate-limit overage flows through `audit({ acao: 'rate_limit_exceeded' })`,
 * which increments `maia_audit_events_total`. Before this fix the counter only
 * carried `{action}` — dashboards/alerts could see "global overage rate" but
 * NOT "overage per tenant". A noisy tenant was indistinguishable from many
 * tenants each within quota.
 *
 * The fix adds `tenant_id`+`agent_id` labels, read from the active
 * `runWithTenantContext` ALS. Outside any tenant context the row falls back to
 * the synthetic `system` bucket (matching the audit row's tenant attribution).
 *
 * These tests exercise the real `audit()` against the real `incCounter` →
 * `renderPrometheus()` path so we catch label-encoding bugs end-to-end.
 */

const { auditWriteMock } = vi.hoisted(() => ({
  auditWriteMock: vi.fn(),
}));

vi.mock('../../src/db/repositories.js', () => ({
  auditRepo: { write: auditWriteMock },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { audit } from '../../src/governance/audit.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { _resetForTests, renderPrometheus } from '../../src/lib/metrics.js';

describe('audit() — rate-limit counter carries tenant_id/agent_id labels (#271)', () => {
  beforeEach(() => {
    auditWriteMock.mockReset();
    auditWriteMock.mockResolvedValue(undefined);
    _resetForTests();
  });

  it('rate_limit_exceeded emit inside a tenant context labels the counter with that tenant+agent', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-1' },
      () =>
        audit({
          acao: 'rate_limit_exceeded',
          metadata: { count: 41, threshold: 30 },
        }),
    );

    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-1",tenant_id="tenant-A"} 1',
    );
    // Confirm: no "blind" (tenant_id-less) sample is emitted as a side effect.
    expect(out).not.toMatch(
      /maia_audit_events_total\{action="rate_limit_exceeded"\} \d+/,
    );
  });

  it('two tenants emit SEPARATE counter samples (no cross-tenant aggregation)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-1' },
      async () => {
        await audit({ acao: 'rate_limit_exceeded' });
        await audit({ acao: 'rate_limit_exceeded' });
      },
    );
    await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-2' },
      () => audit({ acao: 'rate_limit_exceeded' }),
    );

    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-1",tenant_id="tenant-A"} 2',
    );
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-2",tenant_id="tenant-B"} 1',
    );
  });

  it('symmetry: tenant-B → tenant-A order produces the same per-tenant attribution', async () => {
    // The success-path counter is a `Map<labelKey, number>` — order of writes
    // must not collapse different tenants onto a shared key.
    await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-2' },
      () => audit({ acao: 'rate_limit_exceeded' }),
    );
    await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-1' },
      () => audit({ acao: 'rate_limit_exceeded' }),
    );

    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-1",tenant_id="tenant-A"} 1',
    );
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-2",tenant_id="tenant-B"} 1',
    );
  });

  it('outside any tenant context, falls back to the `system` bucket — matches audit row attribution', async () => {
    // Setup/baileys-pairing/startup paths run outside runWithTenantContext;
    // the synthetic `system` bucket must show up on the COUNTER too, not
    // just on the audit row, so dashboards reconcile.
    await audit({ acao: 'whatsapp_connected', metadata: {} });

    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_audit_events_total{action="whatsapp_connected",agent_id="system",tenant_id="system"} 1',
    );
  });

  it('different agents inside the same tenant produce separate samples', async () => {
    // tenant_id alone is not sufficient — multi-agent tenants need per-agent
    // attribution (spec 17 + tenant-isolation principle).
    await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-1' },
      () => audit({ acao: 'rate_limit_exceeded' }),
    );
    await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-2' },
      () => audit({ acao: 'rate_limit_exceeded' }),
    );

    const out = await renderPrometheus();
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-1",tenant_id="tenant-A"} 1',
    );
    expect(out).toContain(
      'maia_audit_events_total{action="rate_limit_exceeded",agent_id="agent-2",tenant_id="tenant-A"} 1',
    );
  });
});
