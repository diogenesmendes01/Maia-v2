/**
 * P8a Task 2 — BaseContextBuilder tests.
 *
 * Builder must produce a BaseContextPacket in <100ms with stable HMACs and
 * a feature flag snapshot captured at entry time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BaseContextBuilder,
  type FeatureFlagsPort,
  type IdentityResolverPort,
} from '@/runtime/context-packet/base-context-builder.js';

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
