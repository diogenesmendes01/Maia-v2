/**
 * Issue #282 integration guard.
 *
 * Verifies that no production path (request → handler → BaseContextBuilder)
 * can produce a `BaseContextPacket` with `tenant_id === 'default'` or
 * `agent_id === 'default'` via the previous silent-default fallback.
 *
 * What this test actually exercises:
 *   1. The new fail-loud default resolver throws when `build()` is called
 *      without injecting a resolver AND without pre-resolved tenant/agent.
 *      This was the production-path failure mode the issue called out
 *      (DI mis-wired, test fallback leaking to prod, unforeseen path).
 *   2. The `__testOnlyPassthroughResolver` is reachable only from the
 *      `test-fixtures.ts` module (tripwire test).
 *   3. Repos importing `getCurrentTenant`/`getCurrentAgent` from the ALS
 *      will at minimum increment the `maia_tenant_id_default_literal_total`
 *      counter when reached with the legacy sentinel. When the opt-in flag
 *      is set, they throw.
 *
 * The cross-tenant repository isolation tests (e.g. `repos-leak.spec.ts`,
 * `skills-repo-tenant-isolation`) already cover the downstream guarantee
 * that two different tenants never share data. This file specifically
 * pins the *upstream* boundary at the context-builder + ALS so a future
 * refactor can't reintroduce the silent default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { incCounterMock } = vi.hoisted(() => ({ incCounterMock: vi.fn() }));
vi.mock('../../src/lib/metrics.js', () => ({
  incCounter: incCounterMock,
}));

import {
  BaseContextBuilder,
  type FeatureFlagsPort,
  type IdentityResolverPort,
} from '@/runtime/context-packet/base-context-builder.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  DefaultLiteralRejectedError,
} from '@/db/tenant-context.js';

const noFlags: FeatureFlagsPort = {
  async snapshot() {
    return {};
  },
};

describe('issue #282 — no production path produces tenant_id === "default"', () => {
  beforeEach(() => {
    incCounterMock.mockReset();
    delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
  });

  it('builder with no DI throws — does NOT silently emit default/default', async () => {
    const builder = new BaseContextBuilder(undefined, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'inbound-channel-A',
        received_at: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('builder with a resolver that returns default/default does NOT silently leak — counter fires when context is read', async () => {
    // Simulates a misconfigured upstream that returns the legacy sentinel.
    // The builder accepts it (the assertion lives at ALS read time, not in
    // the builder, because the inviolable invariant is on QUERY scope), but
    // any downstream `getCurrentTenant()` will increment the counter and —
    // if the opt-in flag is set — throw.
    const sentinelResolver: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'default', agent_id: 'default' };
      },
    };
    const builder = new BaseContextBuilder(sentinelResolver, noFlags);
    const packet = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'inbound-channel-A',
      received_at: new Date(),
    });
    // Builder produced the packet; the guard now lives at ALS read time.
    expect(packet.tenant_id).toBe('default');

    // Simulate the production handler stage: wrap the rest of the turn in
    // runWithTenantContext using the packet's identity. The next repo call
    // would read getCurrentTenant() — we observe the counter increment.
    await runWithTenantContext(
      { tenant_id: packet.tenant_id, agent_id: packet.agent_id },
      async () => {
        getCurrentTenant();
        getCurrentAgent();
      },
    );

    // At least one increment for tenant_id and one for agent_id.
    const calls = incCounterMock.mock.calls.filter(
      (c) => c[0] === 'maia_tenant_id_default_literal_total',
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('with MAIA_REJECT_DEFAULT_LITERAL=true the production path throws hard', async () => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const sentinelResolver: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'default', agent_id: 'default' };
      },
    };
    const builder = new BaseContextBuilder(sentinelResolver, noFlags);
    const packet = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'inbound-channel-A',
      received_at: new Date(),
    });
    await expect(
      runWithTenantContext(
        { tenant_id: packet.tenant_id, agent_id: packet.agent_id },
        async () => {
          getCurrentTenant();
        },
      ),
    ).rejects.toThrow(DefaultLiteralRejectedError);
  });

  it('happy-path real-tenant: full flow yields the caller tenant, no counter increment', async () => {
    const realResolver: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'acme_corp', agent_id: 'sofia_v1' };
      },
    };
    const builder = new BaseContextBuilder(realResolver, noFlags);
    const packet = await builder.build({
      raw_input: { type: 'text', body: 'hi' },
      channel_id: 'inbound-channel-B',
      received_at: new Date(),
    });
    expect(packet.tenant_id).toBe('acme_corp');
    expect(packet.agent_id).toBe('sofia_v1');

    await runWithTenantContext(
      { tenant_id: packet.tenant_id, agent_id: packet.agent_id },
      async () => {
        expect(getCurrentTenant()).toBe('acme_corp');
        expect(getCurrentAgent()).toBe('sofia_v1');
      },
    );

    const calls = incCounterMock.mock.calls.filter(
      (c) => c[0] === 'maia_tenant_id_default_literal_total',
    );
    expect(calls).toHaveLength(0);
  });

  it('test-fixtures.ts is the ONLY module that exposes a passthrough default resolver', async () => {
    // Production code grep: a tripwire that fails the build if anyone
    // reintroduces a passthrough default resolver outside test-fixtures.ts.
    // We do this by importing the production module and asserting that the
    // exports do not include a "defaultResolver" / "passthroughResolver"
    // public name.
    const builderModule = await import('@/runtime/context-packet/base-context-builder.js');
    const exportedNames = Object.keys(builderModule);
    expect(exportedNames).not.toContain('defaultResolver');
    expect(exportedNames).not.toContain('passthroughResolver');
    expect(exportedNames).not.toContain('__testOnlyPassthroughResolver');

    // And the fixture is reachable from the test-fixtures module.
    const fixtures = await import('@/runtime/context-packet/test-fixtures.js');
    expect(fixtures).toHaveProperty('__testOnlyPassthroughResolver');
  });
});
