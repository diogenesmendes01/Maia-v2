/**
 * P8a Task 4 — SliceBuilder interface contract tests.
 *
 * Validates the shape every concrete slice builder must satisfy.
 */
import { describe, it, expect } from 'vitest';
import type {
  SliceBuilder,
  SliceBuilderInput,
} from '@/runtime/context-assembly/slice-builders/_types.js';
import type { IdentitySlice } from '@/runtime/context-packet/types.js';
import { mockBase, mockDecision } from './_fixture.js';

describe('SliceBuilder interface contract', () => {
  it('cacheKey is deterministic for the same input', () => {
    const builder: SliceBuilder<{ depth: string }, IdentitySlice> = {
      name: 'identity',
      build: async () => ({
        slice: {} as IdentitySlice,
        cache_hit: false,
        duration_ms: 0,
      }),
      cacheKey: (base, req) => `${base.tenant_id}:${base.agent_id}:${req.depth}`,
    };

    const base = mockBase();
    const key1 = builder.cacheKey(base, { depth: 'full' });
    const key2 = builder.cacheKey(base, { depth: 'full' });
    expect(key1).toBe(key2);

    // Different requirements → different key
    const key3 = builder.cacheKey(base, { depth: 'minimal' });
    expect(key1).not.toBe(key3);
  });

  it('build returns slice + cache_hit + duration_ms', async () => {
    const builder: SliceBuilder<unknown, IdentitySlice> = {
      name: 'identity',
      build: async (_input: SliceBuilderInput<unknown>) => {
        const start = performance.now();
        await new Promise((r) => setTimeout(r, 5));
        return {
          slice: {
            role_descriptor: 'test',
            voice: { tone: '', formality: '', verbosity: '' },
            cognitive_limits: {
              max_inference_depth: 0,
              max_speculation_in_response: 0,
              confidence_floor_for_action: 0,
            },
            priorities: [],
            learned_voice_modifiers: [],
            schema_version: 'v3.1.1',
            version_id: 'v1',
          },
          cache_hit: false,
          duration_ms: performance.now() - start,
        };
      },
      cacheKey: () => 'key1',
    };

    const result = await builder.build({
      base: mockBase(),
      requirements: {},
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });

    expect(result.slice.role_descriptor).toBe('test');
    expect(result.cache_hit).toBe(false);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it('builder.name returns one of the SliceName union values', () => {
    const allowed = [
      'identity',
      'user',
      'knowledge',
      'soul',
      'policy',
      'skill',
      'tool',
      'history',
    ];
    const builder: SliceBuilder<unknown, IdentitySlice> = {
      name: 'identity',
      build: async () => ({
        slice: {} as IdentitySlice,
        cache_hit: false,
        duration_ms: 0,
      }),
      cacheKey: () => '',
    };
    expect(allowed).toContain(builder.name);
  });
});
