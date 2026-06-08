/**
 * P8a Task 2 — BaseContextBuilder tests.
 *
 * Builder must produce a BaseContextPacket in <100ms with stable HMACs and
 * a feature flag snapshot captured at entry time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BaseContextBuilder,
  type FeatureFlagsPort,
  type IdentityResolverPort,
} from '@/runtime/context-packet/base-context-builder.js';
import { DefaultLiteralRejectedError } from '@/db/tenant-context.js';

const mockResolver: IdentityResolverPort = {
  async resolve(_channel_id: string) {
    return { tenant_id: 'tenant1', agent_id: 'agent1' };
  },
};

const mockFlags: FeatureFlagsPort = {
  async snapshot(_tenant_id: string) {
    return { FEATURE_CONTEXT_PACKET_V1: true };
  },
};

describe('BaseContextBuilder', () => {
  let builder: BaseContextBuilder;

  beforeEach(() => {
    builder = new BaseContextBuilder(mockResolver, mockFlags);
  });

  it('builds base context in <100ms with valid trace_id (UUID)', async () => {
    const start = performance.now();
    const base = await builder.build({
      raw_input: { type: 'text', body: 'hello' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    const elapsed = performance.now() - start;
    expect(base.trace_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(base.tenant_id).toBe('tenant1');
    expect(base.agent_id).toBe('agent1');
    expect(base.input.content_hmac).toBeTruthy();
    expect(elapsed).toBeLessThan(100);
  });

  it('computes tenant-scoped content_hmac (deterministic per body)', async () => {
    const base1 = await builder.build({
      raw_input: { type: 'text', body: 'hello' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    const base2 = await builder.build({
      raw_input: { type: 'text', body: 'hello' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    expect(base1.input.content_hmac).toBe(base2.input.content_hmac);
    // Different content → different hmac
    const base3 = await builder.build({
      raw_input: { type: 'text', body: 'world' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    expect(base1.input.content_hmac).not.toBe(base3.input.content_hmac);
  });

  it('snapshots feature flags at entry time', async () => {
    const base = await builder.build({
      raw_input: { type: 'text', body: 'x' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    expect(typeof base.feature_flags_snapshot).toBe('object');
    expect('FEATURE_CONTEXT_PACKET_V1' in base.feature_flags_snapshot).toBe(true);
    expect(base.feature_flags_snapshot.FEATURE_CONTEXT_PACKET_V1).toBe(true);
  });

  it('throws when resolver returns empty tenant/agent', async () => {
    const emptyResolver: IdentityResolverPort = {
      async resolve(_c: string) {
        return { tenant_id: '', agent_id: '' };
      },
    };
    const emptyBuilder = new BaseContextBuilder(emptyResolver, mockFlags);
    await expect(
      emptyBuilder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
      }),
    ).rejects.toThrow(/failed to resolve tenant\/agent/i);
  });

  it('accepts pre-resolved tenant/agent without calling resolver', async () => {
    let resolverCalled = false;
    const spyingResolver: IdentityResolverPort = {
      async resolve(_c: string) {
        resolverCalled = true;
        return { tenant_id: 'wrong', agent_id: 'wrong' };
      },
    };
    const spyBuilder = new BaseContextBuilder(spyingResolver, mockFlags);
    const base = await spyBuilder.build({
      raw_input: { type: 'text' },
      channel_id: 'ch1',
      received_at: new Date(),
      tenant_id: 'preresolved_tenant',
      agent_id: 'preresolved_agent',
    });
    expect(resolverCalled).toBe(false);
    expect(base.tenant_id).toBe('preresolved_tenant');
    expect(base.agent_id).toBe('preresolved_agent');
  });

  it('different tenants produce different HMACs for same body', async () => {
    const t1: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'tA', agent_id: 'a' };
      },
    };
    const t2: IdentityResolverPort = {
      async resolve() {
        return { tenant_id: 'tB', agent_id: 'a' };
      },
    };
    const b1 = await new BaseContextBuilder(t1, mockFlags).build({
      raw_input: { type: 'text', body: 'same' },
      channel_id: 'ch',
      received_at: new Date(),
    });
    const b2 = await new BaseContextBuilder(t2, mockFlags).build({
      raw_input: { type: 'text', body: 'same' },
      channel_id: 'ch',
      received_at: new Date(),
    });
    expect(b1.input.content_hmac).not.toBe(b2.input.content_hmac);
  });
});

/**
 * Issue #282 regression guard: the previous `defaultResolver` returned
 * `{tenant_id:'default', agent_id:'default'}` from the class-level default
 * constructor parameter. If production ever reached it (DI mis-wired,
 * accidental no-arg `new BaseContextBuilder()`), a synthetic shared context
 * leaked into BaseContextPacket and broke tenant isolation.
 *
 * The fix replaces that default with a fail-loud resolver that throws.
 * Tests that need a passthrough opt in explicitly via the test-fixtures
 * module.
 */
describe('BaseContextBuilder — issue #282 fail-loud default resolver', () => {
  // The passthrough-resolver case below depends on the flag being OFF (meter-
  // only). Guard against env leakage from other tests/files (issue #315).
  beforeEach(() => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
  });

  it('default constructor (no resolver injected) throws when build() must resolve', async () => {
    const noFlags: FeatureFlagsPort = {
      async snapshot() {
        return {};
      },
    };
    const builder = new BaseContextBuilder(undefined, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
      }),
    ).rejects.toThrow(/issue #282|fail-loud|no IdentityResolverPort injected/i);
  });

  it('default constructor never silently returns tenant_id/agent_id = "default"', async () => {
    // Regression guard: this is the inviolable invariant. If the resolver is
    // ever changed back to a silent default, this test must catch it.
    const noFlags: FeatureFlagsPort = {
      async snapshot() {
        return {};
      },
    };
    const builder = new BaseContextBuilder(undefined, noFlags);
    let packet: { tenant_id: string; agent_id: string } | null = null;
    try {
      packet = await builder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
      });
    } catch {
      // Throw is the expected path. Falling through means the resolver
      // returned something — must not be the default sentinel.
    }
    if (packet) {
      expect(packet.tenant_id).not.toBe('default');
      expect(packet.agent_id).not.toBe('default');
    }
  });

  it('pre-resolved tenant/agent path still works without an injected resolver', async () => {
    // The fail-loud default is only reached when build() must call resolve().
    // When the caller pre-resolves (the real production path via react-loop),
    // resolve() is never invoked, so the fail-loud default is harmless.
    const noFlags: FeatureFlagsPort = {
      async snapshot() {
        return {};
      },
    };
    const builder = new BaseContextBuilder(undefined, noFlags);
    const base = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'ch1',
      received_at: new Date(),
      tenant_id: 'real_tenant',
      agent_id: 'real_agent',
    });
    expect(base.tenant_id).toBe('real_tenant');
    expect(base.agent_id).toBe('real_agent');
  });

  it('__testOnlyPassthroughResolver is available for tests that need the legacy behaviour', async () => {
    const { __testOnlyPassthroughResolver } = await import(
      '@/runtime/context-packet/test-fixtures.js'
    );
    const noFlags: FeatureFlagsPort = {
      async snapshot() {
        return {};
      },
    };
    const builder = new BaseContextBuilder(__testOnlyPassthroughResolver, noFlags);
    const base = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    // Confirms the fixture preserves the legacy `default/default` shape so
    // tests that depended on it can opt in explicitly. assertTruthyContext
    // in tenant-context.ts is the second line of defence at ALS read time.
    // (Flag is OFF here → builder meters but does not throw — issue #315.)
    expect(base.tenant_id).toBe('default');
    expect(base.agent_id).toBe('default');
  });
});

/**
 * Issue #315 — BaseContextBuilder rejects the literal 'default' tenant/agent.
 *
 * The builder reuses the SAME `assertNotDefaultLiteral` helper as the ALS
 * read-time getters, so it shares one flag (`MAIA_REJECT_DEFAULT_LITERAL`),
 * one counter (`maia_tenant_id_default_literal_total`), and one error type
 * (`DefaultLiteralRejectedError`). Behaviour is opt-in: meter-only by default,
 * hard throw when the flag is on (kept opt-in until every legacy worker /
 * single-tenant path is migrated off the `default/default` sentinel).
 */
describe("BaseContextBuilder — issue #315 'default' literal rejection", () => {
  const noFlags: FeatureFlagsPort = {
    async snapshot() {
      return {};
    },
  };
  const sentinelResolver: IdentityResolverPort = {
    async resolve() {
      return { tenant_id: 'default', agent_id: 'default' };
    },
  };

  beforeEach(() => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
  });
  afterEach(() => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
  });

  it('default mode (flag off): meters but does NOT throw on default/default', async () => {
    const builder = new BaseContextBuilder(sentinelResolver, noFlags);
    const base = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'ch1',
      received_at: new Date(),
    });
    expect(base.tenant_id).toBe('default');
    expect(base.agent_id).toBe('default');
  });

  it('opt-in mode (flag on): throws DefaultLiteralRejectedError on resolved default tenant', async () => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const builder = new BaseContextBuilder(sentinelResolver, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
      }),
    ).rejects.toThrow(DefaultLiteralRejectedError);
  });

  it('opt-in mode: throws on a pre-resolved default tenant_id (no resolver call)', async () => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const builder = new BaseContextBuilder(undefined, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
        tenant_id: 'default',
        agent_id: 'real_agent',
      }),
    ).rejects.toThrow(DefaultLiteralRejectedError);
  });

  it('opt-in mode: throws on a pre-resolved default agent_id', async () => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const builder = new BaseContextBuilder(undefined, noFlags);
    await expect(
      builder.build({
        raw_input: { type: 'text' },
        channel_id: 'ch1',
        received_at: new Date(),
        tenant_id: 'real_tenant',
        agent_id: 'default',
      }),
    ).rejects.toThrow(DefaultLiteralRejectedError);
  });

  it('opt-in mode: a real tenant/agent pair still builds (guard only fires on the sentinel)', async () => {
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    const builder = new BaseContextBuilder(undefined, noFlags);
    const base = await builder.build({
      raw_input: { type: 'text' },
      channel_id: 'ch1',
      received_at: new Date(),
      tenant_id: 'acme_corp',
      agent_id: 'sofia_v1',
    });
    expect(base.tenant_id).toBe('acme_corp');
    expect(base.agent_id).toBe('sofia_v1');
  });
});
