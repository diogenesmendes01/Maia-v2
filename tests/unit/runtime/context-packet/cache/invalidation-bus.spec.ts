/**
 * P8a Task 12 — InvalidationBus tests.
 *
 * Validates handler subscription, dispatch ordering, and default routing of
 * the 11 invalidation event types to their respective slice caches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InvalidationBus,
  wireDefaultInvalidationHandlers,
  EVENT_TO_SLICE,
  type InvalidationEventType,
} from '@/runtime/context-packet/cache/invalidation-bus.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';

describe('InvalidationBus', () => {
  let bus: InvalidationBus;

  beforeEach(() => {
    bus = new InvalidationBus();
  });

  it('subscribes a handler and invokes it on dispatch', async () => {
    let called = false;
    bus.subscribe('policy_rule_activated', async () => {
      called = true;
    });
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 'tenant1',
      occurred_at: new Date().toISOString(),
    });
    expect(called).toBe(true);
  });

  it('dispatches no-op when no handlers registered', async () => {
    await expect(
      bus.dispatch({
        type: 'soul_bias_activated',
        tenant_id: 't',
        occurred_at: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('invokes all handlers for an event type', async () => {
    let h1 = 0;
    let h2 = 0;
    bus.subscribe('policy_rule_activated', async () => {
      h1++;
    });
    bus.subscribe('policy_rule_activated', async () => {
      h2++;
    });
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 't',
      occurred_at: new Date().toISOString(),
    });
    expect(h1).toBe(1);
    expect(h2).toBe(1);
  });

  it('isolates handler failures (one throws, others still run)', async () => {
    let okHandlerRan = false;
    bus.subscribe('policy_rule_activated', async () => {
      throw new Error('boom');
    });
    bus.subscribe('policy_rule_activated', async () => {
      okHandlerRan = true;
    });
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 't',
      occurred_at: new Date().toISOString(),
    });
    expect(okHandlerRan).toBe(true);
  });

  it('EVENT_TO_SLICE maps all 11 invalidation events', () => {
    const eventTypes: InvalidationEventType[] = [
      'identity_profile_activated',
      'identity_profile_rolled_back',
      'user_memory_upserted',
      'user_memory_invalidated',
      'user_behavioral_hint_added',
      'knowledge_lifecycle_transitioned',
      'soul_bias_activated',
      'policy_rule_activated',
      'policy_rule_deactivated',
      'skill_activated',
      'tool_registry_updated',
    ];
    expect(Object.keys(EVENT_TO_SLICE)).toHaveLength(11);
    for (const t of eventTypes) {
      expect(EVENT_TO_SLICE[t]).toBeDefined();
    }
  });

  it('wireDefaultInvalidationHandlers registers a handler for every event type', () => {
    const cache = new InMemorySliceCache();
    wireDefaultInvalidationHandlers(bus, cache);
    for (const t of Object.keys(EVENT_TO_SLICE) as InvalidationEventType[]) {
      expect(bus.handlerCount(t)).toBe(1);
    }
  });

  it('default policy_rule_activated handler invalidates tenant policy cache', async () => {
    const cache = new InMemorySliceCache();
    // Issue #235: layout is `maia:context:v2:{tenant}:{agent}:{slice}:{scope}`.
    await cache.set('maia:context:v2:tenant1:agentA:policy:scope1', { x: 1 }, 300);
    await cache.set('maia:context:v2:tenant2:agentA:policy:scope1', { y: 2 }, 300);

    wireDefaultInvalidationHandlers(bus, cache);
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 'tenant1',
      occurred_at: new Date().toISOString(),
    });

    expect(await cache.get('maia:context:v2:tenant1:agentA:policy:scope1')).toBeNull();
    expect(await cache.get('maia:context:v2:tenant2:agentA:policy:scope1')).toEqual({
      y: 2,
    });
  });

  it('default policy_rule_activated handler invalidates all agents of the tenant', async () => {
    // Issue #235: tenant-scoped invalidation MUST clear every agent's slice
    // under that tenant. Wildcards the agent_id position in the key glob.
    const cache = new InMemorySliceCache();
    await cache.set('maia:context:v2:tenant1:agentA:policy:scope1', { x: 1 }, 300);
    await cache.set('maia:context:v2:tenant1:agentB:policy:scope1', { y: 2 }, 300);
    await cache.set('maia:context:v2:tenant1:agentA:identity:scope1', { z: 3 }, 300);

    wireDefaultInvalidationHandlers(bus, cache);
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 'tenant1',
      occurred_at: new Date().toISOString(),
    });

    expect(await cache.get('maia:context:v2:tenant1:agentA:policy:scope1')).toBeNull();
    expect(await cache.get('maia:context:v2:tenant1:agentB:policy:scope1')).toBeNull();
    // Other slices stay.
    expect(await cache.get('maia:context:v2:tenant1:agentA:identity:scope1')).toEqual({
      z: 3,
    });
  });

  it('default identity_profile_activated handler invalidates identity slice only', async () => {
    const cache = new InMemorySliceCache();
    await cache.set('maia:context:v2:tenant1:agentA:identity:s1', { i: 1 }, 300);
    await cache.set('maia:context:v2:tenant1:agentA:policy:s1', { p: 1 }, 300);

    wireDefaultInvalidationHandlers(bus, cache);
    await bus.dispatch({
      type: 'identity_profile_activated',
      tenant_id: 'tenant1',
      occurred_at: new Date().toISOString(),
    });

    expect(await cache.get('maia:context:v2:tenant1:agentA:identity:s1')).toBeNull();
    expect(await cache.get('maia:context:v2:tenant1:agentA:policy:s1')).toEqual({ p: 1 });
  });
});
