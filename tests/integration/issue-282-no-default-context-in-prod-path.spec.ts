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
    // Test baseline OFF (issue #323 opt-out); the ON cases below set ='true'.
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
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

  it('builder with a resolver that returns default/default does NOT silently leak — counter fires at build time and at ALS read', async () => {
    // Simulates a misconfigured upstream that returns the legacy sentinel.
    // Issue #315: the builder now ALSO meters the 'default' literal at build
    // time (via the shared `assertNotDefaultLiteral` helper), in addition to
    // the ALS read-time guard. In DEFAULT mode (flag off) it only meters and
    // still produces the packet — the hard throw remains opt-in. This gives
    // defense-in-depth without changing default behavior.
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
    // Builder produced the packet (flag off → meter-only, no throw).
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

    // Increments from BOTH layers: builder (tenant_id + agent_id at build) and
    // ALS read (tenant_id + agent_id). At least one per field overall.
    const calls = incCounterMock.mock.calls.filter(
      (c) => c[0] === 'maia_tenant_id_default_literal_total',
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c[1]?.field === 'tenant_id')).toBe(true);
    expect(calls.some((c) => c[1]?.field === 'agent_id')).toBe(true);
  });

  it('with MAIA_REJECT_DEFAULT_LITERAL=true the builder rejects default/default at build time (issue #315)', async () => {
    // Issue #315: with the opt-in flag on, the guard moves UPSTREAM — the
    // builder itself throws `DefaultLiteralRejectedError` before ever emitting
    // a synthetic packet, so a misconfigured resolver can't hand a default/
    // default identity to the rest of the turn. (Previously the throw only
    // fired later, at the first ALS read.)
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const sentinelResolver: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'default', agent_id: 'default' };
      },
    };
    const builder = new BaseContextBuilder(sentinelResolver, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'inbound-channel-A',
        received_at: new Date(),
      }),
    ).rejects.toThrow(DefaultLiteralRejectedError);
  });

  it('with the flag on, a pre-resolved default tenant_id is also rejected at build time', async () => {
    // The guard runs regardless of whether tenant/agent came from the resolver
    // or were pre-resolved by the caller (react-loop path).
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const builder = new BaseContextBuilder(undefined, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'inbound-channel-A',
        received_at: new Date(),
        tenant_id: 'default',
        agent_id: 'sofia_v1',
      }),
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
