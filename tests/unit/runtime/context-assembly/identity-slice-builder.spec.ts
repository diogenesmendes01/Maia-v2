/**
 * P8a Task 5 — IdentitySliceBuilder tests.
 *
 * Coverage: happy path (full + minimal depth), empty profile, abort signal,
 * cache hit/miss, cache invalidation via event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IdentitySliceBuilder,
  type OperationalProfilePort,
  type OperationalProfileRecord,
} from '@/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import {
  InvalidationBus,
  wireDefaultInvalidationHandlers,
} from '@/runtime/context-packet/cache/invalidation-bus.js';
import { mockBase, mockDecision } from './_fixture.js';

const PROFILE_RECORD: OperationalProfileRecord = {
  id: 'profile-v3',
  profile_body: {
    schema_version: 'v3.1.1-2026-05-15',
    identity: {
      role_descriptor: 'Assistente financeira',
      voice: { tone: 'amistoso', formality: 'medium', verbosity: 'concise' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      priorities: ['proteger autonomia do owner', 'preservar evidência'],
      learned_voice_modifiers: [
        { aspect: 'tom', modifier: 'mais direto à noite', strength: 0.6 },
      ],
    },
  },
};

const emptyRepo = (): OperationalProfilePort => ({
  async getActive() {
    return null;
  },
});

const withRepo = (record: OperationalProfileRecord): OperationalProfilePort => ({
  async getActive() {
    return record;
  },
});

describe('IdentitySliceBuilder', () => {
  let cache: InMemorySliceCache;

  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('reads role_descriptor, voice, cognitive_limits, priorities for depth=full', async () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const result = await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(result.slice.role_descriptor).toBe('Assistente financeira');
    expect(result.slice.voice.tone).toBe('amistoso');
    expect(result.slice.cognitive_limits.max_inference_depth).toBe(3);
    expect(result.slice.priorities).toHaveLength(2);
    expect(result.slice.learned_voice_modifiers).toHaveLength(1);
    expect(result.slice.version_id).toBe('profile-v3');
    expect(result.cache_hit).toBe(false);
  });

  it('omits priorities and learned_voice_modifiers for depth=minimal', async () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const result = await builder.build({
      base: mockBase(),
      requirements: { depth: 'minimal' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(result.slice.role_descriptor).toBe('Assistente financeira');
    expect(result.slice.priorities).toEqual([]);
    expect(result.slice.learned_voice_modifiers).toEqual([]);
  });

  it('cache key includes tenant_id and agent_id', () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const key = builder.cacheKey(mockBase(), { depth: 'full' });
    expect(key).toContain('tenant1');
    expect(key).toContain('identity');
  });

  it('returns empty identity when no profile is active', async () => {
    const builder = new IdentitySliceBuilder(emptyRepo(), cache);
    const result = await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(result.slice.role_descriptor).toBe('');
    expect(result.slice.priorities).toEqual([]);
    expect(result.slice.version_id).toBe('');
  });

  it('respects abort signal (throws AbortError when pre-aborted)', async () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const controller = new AbortController();
    controller.abort();
    await expect(
      builder.build({
        base: mockBase(),
        requirements: { depth: 'full' },
        decision: mockDecision(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns cache_hit=true on second call with same key', async () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const first = await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(first.cache_hit).toBe(false);

    const second = await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(second.cache_hit).toBe(true);
    expect(second.slice.role_descriptor).toBe('Assistente financeira');
  });

  it('cache invalidates on identity_profile_activated event', async () => {
    const builder = new IdentitySliceBuilder(withRepo(PROFILE_RECORD), cache);
    const bus = new InvalidationBus();
    wireDefaultInvalidationHandlers(bus, cache);

    // Prime cache
    await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });

    // Dispatch invalidation
    await bus.dispatch({
      type: 'identity_profile_activated',
      tenant_id: 'tenant1',
      occurred_at: new Date().toISOString(),
    });

    // Next call should miss
    const after = await builder.build({
      base: mockBase(),
      requirements: { depth: 'full' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(after.cache_hit).toBe(false);
  });
});
