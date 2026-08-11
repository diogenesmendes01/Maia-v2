import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Issue #511 — turn-context cache.
 *
 * The cache is the one part of #511 that can serve stale data, so the tests
 * that matter are the safety ones, not the hit-rate ones:
 *
 *  - a cache key can never collapse two tenants or two agents onto one entry;
 *  - a degenerate scope (`''`, `'default'`) is rejected rather than encoded;
 *  - nothing authorization-bearing is cacheable, structurally;
 *  - invalidation crosses replicas, and a foreign payload on a tenant's channel
 *    cannot flush that tenant's entries.
 */

vi.mock('../../src/config/env.js', () => ({
  config: {
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    FEATURE_TURN_CONTEXT_CACHE: true,
    TURN_CONTEXT_CACHE_TTL_MS: 300_000,
    TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS: 30_000,
    TURN_CONTEXT_CACHE_MAX_ENTRIES: 5_000,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  TurnContextCache,
  turnContextCacheKey,
  turnContextInvalidationChannel,
  parseTurnContextInvalidationChannel,
  handleTurnContextInvalidationMessage,
  startTurnContextCacheInvalidationSubscriber,
  _resetTurnContextSubscriberForTests,
  _setTurnContextSubscriberFactoryForTests,
  _subscribeTenantForTests,
  InvalidCacheScopeError,
  CACHEABLE_RESOURCES,
  type CacheableResource,
} from '../../src/agent/turn-context/cache.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { renderPrometheus, _resetForTests as _resetMetrics } from '../../src/lib/metrics.js';

function mkCache(over: Partial<{ ttl_ms: number; negative_ttl_ms: number; max_entries: number }> = {}) {
  return new TurnContextCache({
    ttl_ms: over.ttl_ms ?? 300_000,
    negative_ttl_ms: over.negative_ttl_ms ?? 30_000,
    max_entries: over.max_entries ?? 5_000,
  });
}

const A = { tenant_id: 'acme', agent_id: 'agent-1' };
const B = { tenant_id: 'globex', agent_id: 'agent-1' };

describe('#511 turn-context cache — keys', () => {
  it('scopes every key by tenant AND agent', () => {
    const a = turnContextCacheKey('acme', 'agent-1', 'identity');
    const b = turnContextCacheKey('acme', 'agent-2', 'identity');
    const c = turnContextCacheKey('globex', 'agent-1', 'identity');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('cannot alias two tuples through a colon inside an id', () => {
    // Raw concatenation would make both of these "…:acme:dev:x:identity".
    const one = turnContextCacheKey('acme:dev', 'x', 'identity');
    const two = turnContextCacheKey('acme', 'dev:x', 'identity');
    expect(one).not.toBe(two);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['default', "the legacy 'default' literal"],
  ])('refuses to build a key for tenant_id %j', (tenant) => {
    expect(() => turnContextCacheKey(tenant, 'agent-1', 'identity')).toThrow(
      InvalidCacheScopeError,
    );
  });

  it('refuses to build a key for a degenerate agent_id', () => {
    expect(() => turnContextCacheKey('acme', '', 'identity')).toThrow(InvalidCacheScopeError);
    expect(() => turnContextCacheKey('acme', 'default', 'identity')).toThrow(
      InvalidCacheScopeError,
    );
  });

  it('never lists an authorization-bearing resource as cacheable', () => {
    // The union IS the guard: caching permissions/grants/balances must not be
    // expressible. If this list grows, the growth was a security decision.
    expect([...CACHEABLE_RESOURCES].sort()).toEqual(['identity']);
    for (const forbidden of ['permissions', 'scope', 'grants', 'balance', 'pending']) {
      expect(CACHEABLE_RESOURCES as readonly string[]).not.toContain(forbidden);
    }
  });

  /**
   * Round-1 review, P1: `capabilities` and `gaps` were cached while only
   * profile activation published an invalidation, so a REVOKED skill or a
   * resolved gap stayed visible on other replicas for up to a full TTL. They
   * were removed rather than half-covered. The rule this pins is the general
   * one: a resource may only be cached once EVERY mutation that changes it
   * publishes after commit.
   */
  it('does not cache capabilities or gaps (no publisher coverage yet)', () => {
    expect(CACHEABLE_RESOURCES as readonly string[]).not.toContain('capabilities');
    expect(CACHEABLE_RESOURCES as readonly string[]).not.toContain('gaps');
  });
});

describe('#511 turn-context cache — read path', () => {
  it('loads on miss and serves the second read from cache', async () => {
    const cache = mkCache();
    const load = vi.fn(async () => ({ systemPromptBody: 'x' }));

    const first = await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    const second = await runWithTenantContext(A, () => cache.getOrLoad('identity', load));

    expect(first).toEqual({ systemPromptBody: 'x' });
    expect(second).toEqual({ systemPromptBody: 'x' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('NEVER serves one tenant the other tenant cached value', async () => {
    const cache = mkCache();
    const loadA = vi.fn(async () => 'identity-of-acme');
    const loadB = vi.fn(async () => 'identity-of-globex');

    await runWithTenantContext(A, () => cache.getOrLoad('identity', loadA));
    const forB = await runWithTenantContext(B, () => cache.getOrLoad('identity', loadB));

    expect(forB).toBe('identity-of-globex');
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it('NEVER serves one agent another agent cached value inside a tenant', async () => {
    const cache = mkCache();
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, () =>
      cache.getOrLoad('identity', async () => 'a1-identity'),
    );
    const forA2 = await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a2' }, () =>
      cache.getOrLoad('identity', async () => 'a2-identity'),
    );
    expect(forA2).toBe('a2-identity');
  });

  it('caches a negative result and does not re-hit the DB for it', async () => {
    const cache = mkCache();
    const load = vi.fn(async () => null);

    const first = await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    const second = await runWithTenantContext(A, () => cache.getOrLoad('identity', load));

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats().negative_hits).toBe(1);
  });

  it('expires a negative entry sooner than a positive one', async () => {
    const cache = mkCache({ ttl_ms: 300_000, negative_ttl_ms: 1 });
    const load = vi.fn(async () => null);
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    await new Promise((r) => setTimeout(r, 5));
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    // A profile activated right after the miss must not wait a full TTL.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache when the load throws (no half-loaded section is pinned)', async () => {
    const cache = mkCache();
    const load = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      runWithTenantContext(A, () => cache.getOrLoad('identity', load)),
    ).rejects.toThrow('db down');

    const ok = vi.fn(async () => 'recovered');
    const after = await runWithTenantContext(A, () => cache.getOrLoad('identity', ok));
    expect(after).toBe('recovered');
  });

  it('bypasses (never caches) when the tenant scope is unusable', async () => {
    const cache = mkCache();
    const load = vi.fn(async () => 'value');
    // No ALS frame at all — the read must still work, but nothing is stored.
    const first = await cache.getOrLoad('identity', load);
    const second = await cache.getOrLoad('identity', load);
    expect(first).toBe('value');
    expect(second).toBe('value');
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);
  });
});

describe('#511 turn-context cache — invalidation', () => {
  it('drops only the targeted (tenant, agent, resource)', async () => {
    const cache = mkCache();
    const seed = async (scope: typeof A, resource: CacheableResource, value: string) =>
      runWithTenantContext(scope, () => cache.getOrLoad(resource, async () => value));

    await seed(A, 'identity', 'a-identity');
    await seed(A, 'capabilities', 'a-caps');
    await seed(B, 'identity', 'b-identity');

    expect(cache.invalidate({ ...A, resource: 'identity' })).toBe(1);

    const reloadA = vi.fn(async () => 'a-identity-v2');
    expect(await runWithTenantContext(A, () => cache.getOrLoad('identity', reloadA))).toBe(
      'a-identity-v2',
    );
    // The sibling resource and the other tenant were untouched.
    expect(
      await runWithTenantContext(A, () => cache.getOrLoad('capabilities', async () => 'reloaded')),
    ).toBe('a-caps');
    expect(
      await runWithTenantContext(B, () => cache.getOrLoad('identity', async () => 'reloaded')),
    ).toBe('b-identity');
  });

  it('a tenant-wide event (agent_id null) clears every agent of that tenant only', async () => {
    const cache = mkCache();
    for (const agent_id of ['a1', 'a2']) {
      await runWithTenantContext({ tenant_id: 'acme', agent_id }, () =>
        cache.getOrLoad('identity', async () => `${agent_id}-v1`),
      );
    }
    await runWithTenantContext(B, () => cache.getOrLoad('identity', async () => 'globex-v1'));

    expect(cache.invalidate({ tenant_id: 'acme', agent_id: null, resource: 'identity' })).toBe(2);
    expect(
      await runWithTenantContext(B, () => cache.getOrLoad('identity', async () => 'globex-v2')),
    ).toBe('globex-v1');
  });

  it('a tenant-wide event does NOT clear a look-alike tenant (delimiter aliasing)', async () => {
    const cache = mkCache();
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, () =>
      cache.getOrLoad('identity', async () => 'acme-v1'),
    );
    await runWithTenantContext({ tenant_id: 'acme:dev', agent_id: 'a1' }, () =>
      cache.getOrLoad('identity', async () => 'acme-dev-v1'),
    );

    cache.invalidate({ tenant_id: 'acme', agent_id: null, resource: 'identity' });

    expect(
      await runWithTenantContext({ tenant_id: 'acme:dev', agent_id: 'a1' }, () =>
        cache.getOrLoad('identity', async () => 'acme-dev-v2'),
      ),
    ).toBe('acme-dev-v1');
  });
});

/**
 * Round-1 review, P2. The tenant used to be marked subscribed BEFORE any
 * acknowledgement, which lost invalidations two ways: a first fill that landed
 * before the subscriber finished wiring marked the tenant permanently (never
 * retried), and even on the happy path the entry was readable before the
 * SUBSCRIBE was acked. The cache now refuses to STORE until the subscription is
 * confirmed, and meters the refusal.
 */
describe('#511 turn-context cache — subscription gating', () => {
  it('does not store anything until the subscription is confirmed', async () => {
    let allow = false;
    const cache = new TurnContextCache({
      ttl_ms: 300_000,
      negative_ttl_ms: 30_000,
      max_entries: 100,
      subscribe_retry_ms: 0,
      ensureSubscribed: async () => {
        if (!allow) throw new Error('subscriber not started');
      },
    });
    const load = vi.fn(async () => 'v1');

    // Subscriber not ready → the read works, but nothing is cached.
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);
    expect(cache.subscribedTenantsForTest().has('acme')).toBe(false);

    // Once it is confirmed, the tenant is retried and caching begins.
    allow = true;
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.subscribedTenantsForTest().has('acme')).toBe(true);

    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    expect(load).toHaveBeenCalledTimes(3); // served from cache
  });

  it('meters the refusal instead of degrading silently', async () => {
    _resetMetrics();
    const cache = new TurnContextCache({
      ttl_ms: 300_000,
      negative_ttl_ms: 30_000,
      max_entries: 100,
      subscribe_retry_ms: 0,
      ensureSubscribed: async () => {
        throw new Error('redis down');
      },
    });
    await runWithTenantContext(A, () => cache.getOrLoad('identity', async () => 'v'));

    const exposition = await renderPrometheus();
    // A flat hit rate must be explainable from the metrics alone.
    expect(exposition).toContain(
      'maia_turn_context_cache_total{result="unsubscribed",section="identity"} 1',
    );
  });

  it('backs off between subscribe attempts instead of retrying every miss', async () => {
    const ensureSubscribed = vi.fn(async () => {
      throw new Error('redis down');
    });
    const cache = new TurnContextCache({
      ttl_ms: 300_000,
      negative_ttl_ms: 30_000,
      max_entries: 100,
      subscribe_retry_ms: 60_000,
      ensureSubscribed,
    });

    for (let i = 0; i < 5; i++) {
      await runWithTenantContext(A, () => cache.getOrLoad('identity', async () => 'v'));
    }
    // One attempt, not five — an outage must not become a reconnect storm.
    expect(ensureSubscribed).toHaveBeenCalledTimes(1);
  });

  it('a cache with NO bus configured is an explicit TTL-only cache', async () => {
    // Tests (and a deployment that deliberately runs without the bus) opt out
    // by omitting the hook — that is different from a hook that fails.
    const cache = mkCache();
    const load = vi.fn(async () => 'v');
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    await runWithTenantContext(A, () => cache.getOrLoad('identity', load));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refuses to subscribe when the subscriber was never started', async () => {
    _resetTurnContextSubscriberForTests();
    await expect(_subscribeTenantForTests('acme')).rejects.toThrow(
      /subscriber_not_started/,
    );
  });

  it('only resolves after the client connected AND the channel was subscribed', async () => {
    _resetTurnContextSubscriberForTests();
    const order: string[] = [];
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => {
        order.push('connect');
      },
      subscribe: async (channel: string) => {
        order.push(`subscribe:${channel}`);
      },
    }));
    startTurnContextCacheInvalidationSubscriber();

    await _subscribeTenantForTests('acme');

    expect(order).toEqual(['connect', `subscribe:${turnContextInvalidationChannel('acme')}`]);
    _resetTurnContextSubscriberForTests();
  });

  it('rebuilds the client after a failed connect so a later turn can recover', async () => {
    _resetTurnContextSubscriberForTests();
    let attempts = 0;
    _setTurnContextSubscriberFactoryForTests(async () => {
      attempts++;
      if (attempts === 1) throw new Error('connect refused');
      return {
        on: () => undefined,
        connect: async () => undefined,
        subscribe: async () => undefined,
      };
    });
    startTurnContextCacheInvalidationSubscriber();

    await expect(_subscribeTenantForTests('acme')).rejects.toThrow('connect refused');
    // A transient outage must not disable the cache for the process lifetime.
    await expect(_subscribeTenantForTests('acme')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    _resetTurnContextSubscriberForTests();
  });
});

describe('#511 turn-context cache — cross-replica bus', () => {
  const channel = turnContextInvalidationChannel('acme');

  it('round-trips the tenant through the channel name', () => {
    expect(parseTurnContextInvalidationChannel(channel)).toBe('acme');
    expect(parseTurnContextInvalidationChannel('some:other:channel')).toBeNull();
  });

  it('a published event invalidates on the RECEIVING replica', async () => {
    // Two independent cache instances = two replicas.
    const replica = mkCache();
    await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v1'));

    handleTurnContextInvalidationMessage(
      channel,
      JSON.stringify({
        tenant_id: 'acme',
        agent_id: 'agent-1',
        resource: 'identity',
        occurred_at: new Date().toISOString(),
      }),
      replica,
    );

    expect(await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v2'))).toBe(
      'v2',
    );
  });

  it('drops a payload whose tenant does not match the channel', async () => {
    const replica = mkCache();
    await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v1'));

    // globex publishing onto acme's channel must not flush acme.
    handleTurnContextInvalidationMessage(
      channel,
      JSON.stringify({
        tenant_id: 'globex',
        agent_id: 'agent-1',
        resource: 'identity',
        occurred_at: new Date().toISOString(),
      }),
      replica,
    );

    expect(await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v2'))).toBe(
      'v1',
    );
  });

  it('ignores malformed payloads and unknown resources', async () => {
    const replica = mkCache();
    await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v1'));

    handleTurnContextInvalidationMessage(channel, 'not json', replica);
    handleTurnContextInvalidationMessage(channel, JSON.stringify({ agent_id: 'x' }), replica);
    handleTurnContextInvalidationMessage(
      channel,
      JSON.stringify({ tenant_id: 'acme', agent_id: 'agent-1', resource: 'permissions' }),
      replica,
    );

    expect(await runWithTenantContext(A, () => replica.getOrLoad('identity', async () => 'v2'))).toBe(
      'v1',
    );
  });
});
