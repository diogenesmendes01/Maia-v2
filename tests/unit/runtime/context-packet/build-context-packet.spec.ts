/**
 * P8a Task 13 — buildContextPacket() orchestrator tests.
 *
 * Coverage: parallel assembly, budget <600ms, policy=hard-fail, other-slice
 * fallback, cache_hits in assembly_meta, base_ref / decision_ref HMACs.
 */
import { describe, it, expect } from 'vitest';
import { buildContextPacket } from '@/runtime/context-packet/build-context-packet.js';
import { IdentitySliceBuilder } from '@/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import { UserSliceBuilder } from '@/runtime/context-assembly/slice-builders/user-slice-builder.js';
import { KnowledgeSliceBuilder } from '@/runtime/context-assembly/slice-builders/knowledge-slice-builder.js';
import { SoulSliceBuilder, stubSoulPort } from '@/runtime/context-assembly/slice-builders/soul-slice-builder.js';
import {
  PolicySliceBuilder,
  stubPolicyDescriptorResolver,
} from '@/runtime/context-assembly/slice-builders/policy-slice-builder.js';
import { SkillSliceBuilder } from '@/runtime/context-assembly/slice-builders/skill-slice-builder.js';
import { ToolPermissionSliceBuilder } from '@/runtime/context-assembly/slice-builders/tool-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import type { SliceBuilderSet } from '@/runtime/context-packet/build-context-packet.js';
import type {
  SliceBuilder,
  SliceBuilderResult,
} from '@/runtime/context-assembly/slice-builders/_types.js';
import type {
  HistorySlice,
  PolicySlice,
} from '@/runtime/context-packet/types.js';
import { mockBase, mockDecision } from '../context-assembly/_fixture.js';

function makeStandardBuilders(): {
  builders: SliceBuilderSet;
  cache: InMemorySliceCache;
} {
  const cache = new InMemorySliceCache();
  const identity = new IdentitySliceBuilder(
    {
      async getActive() {
        return {
          id: 'profile-v1',
          profile_body: {
            schema_version: 'v3.1.1',
            identity: {
              role_descriptor: 'maia',
              voice: { tone: 'neutro', formality: 'medium', verbosity: 'concise' },
              cognitive_limits: {
                max_inference_depth: 2,
                max_speculation_in_response: 0.2,
                confidence_floor_for_action: 0.6,
              },
            },
          },
        };
      },
    },
    cache,
  ) as unknown as SliceBuilder<unknown, ReturnType<IdentitySliceBuilder['build']> extends Promise<infer R> ? (R extends SliceBuilderResult<infer S> ? S : never) : never>;

  const user = new UserSliceBuilder(
    {
      async getPessoa() {
        return null;
      },
      async listMemories() {
        return [];
      },
      async listBehavioralHints() {
        return [];
      },
    },
    cache,
  );
  const knowledge = new KnowledgeSliceBuilder(
    {
      async listFacts() {
        return [];
      },
      async listRules() {
        return [];
      },
    },
    cache,
  );
  const soul = new SoulSliceBuilder(stubSoulPort, cache);
  const policy = new PolicySliceBuilder(stubPolicyDescriptorResolver, cache);
  const skill = new SkillSliceBuilder(
    {
      async getSkillById() {
        return null;
      },
      async listSkillSummaries() {
        return [];
      },
    },
    cache,
  );
  const tool = new ToolPermissionSliceBuilder(
    {
      async getToolDescriptor() {
        return null;
      },
    },
    cache,
  );

  return {
    builders: {
      identity: identity as unknown as SliceBuilderSet['identity'],
      user: user as unknown as SliceBuilderSet['user'],
      knowledge: knowledge as unknown as SliceBuilderSet['knowledge'],
      soul: soul as unknown as SliceBuilderSet['soul'],
      policy: policy as unknown as SliceBuilderSet['policy'],
      skill: skill as unknown as SliceBuilderSet['skill'],
      tool: tool as unknown as SliceBuilderSet['tool'],
    },
    cache,
  };
}

const emptyHistory = async (): Promise<HistorySlice> => ({
  turns: [],
  truncated: false,
});

describe('buildContextPacket orchestrator', () => {
  it('assembles 7 slices + history in parallel <600ms', async () => {
    const { builders } = makeStandardBuilders();
    const start = performance.now();
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      { builders, historyLoader: emptyHistory },
    );
    const elapsed = performance.now() - start;
    expect(packet.trace_id).toBeDefined();
    expect(packet.identity).toBeDefined();
    expect(packet.user).toBeDefined();
    expect(packet.knowledge).toBeDefined();
    expect(packet.soul).toBeDefined();
    expect(packet.policy).toBeDefined();
    expect(packet.skill).toBeDefined();
    expect(packet.tool).toBeDefined();
    expect(packet.history).toBeDefined();
    expect(packet.assembly_meta.duration_ms).toBeLessThan(600);
    expect(elapsed).toBeLessThan(600);
  });

  it('policy builder failure → throws (hard fail)', async () => {
    const { builders } = makeStandardBuilders();
    const failingPolicy: SliceBuilder<unknown, PolicySlice> = {
      name: 'policy',
      build: async () => {
        throw new Error('policy DB unreachable');
      },
      cacheKey: () => 'k',
    };
    await expect(
      buildContextPacket(
        { base: mockBase(), decision: mockDecision() },
        {
          builders: { ...builders, policy: failingPolicy },
          historyLoader: emptyHistory,
        },
      ),
    ).rejects.toThrow(/policy DB unreachable/i);
  });

  it('user builder failure → degrades to empty, packet still completes', async () => {
    const { builders } = makeStandardBuilders();
    type UserSliceType = import('@/runtime/context-packet/types.js').UserSlice;
    const failingUser: SliceBuilder<unknown, UserSliceType> = {
      name: 'user',
      build: async () => {
        throw new Error('user repo timeout');
      },
      cacheKey: () => 'k',
    };
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      {
        builders: { ...builders, user: failingUser as unknown as SliceBuilderSet['user'] },
        historyLoader: emptyHistory,
      },
    );
    expect(packet.user.memories).toEqual([]);
    expect(packet.assembly_meta.fallback_depths_applied.user).toBe('degraded');
  });

  it('cache hits populated in assembly_meta on second call', async () => {
    const { builders } = makeStandardBuilders();
    const a = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      { builders, historyLoader: emptyHistory },
    );
    expect(a.assembly_meta.cache_hits.identity).toBe(false);

    const b = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      { builders, historyLoader: emptyHistory },
    );
    expect(b.assembly_meta.cache_hits.identity).toBe(true);
    expect(b.assembly_meta.cache_hits.policy).toBe(true);
  });

  it('computes base_ref + decision_ref 16-char HMACs', async () => {
    const { builders } = makeStandardBuilders();
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      { builders, historyLoader: emptyHistory },
    );
    expect(packet.base_ref).toMatch(/^[a-f0-9]{16}$/);
    expect(packet.decision_ref).toMatch(/^[a-f0-9]{16}$/);
  });

  it('exposes all 7 slice names in assembly_meta.builder_durations_ms', async () => {
    const { builders } = makeStandardBuilders();
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      { builders, historyLoader: emptyHistory },
    );
    const keys = Object.keys(packet.assembly_meta.builder_durations_ms);
    expect(keys.sort()).toEqual(
      ['identity', 'knowledge', 'policy', 'skill', 'soul', 'tool', 'user'].sort(),
    );
  });

  it('emits histogram metric on assembly duration', async () => {
    const { builders } = makeStandardBuilders();
    const recorded: Array<[string, number]> = [];
    await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      {
        builders,
        historyLoader: emptyHistory,
        metrics: {
          recordHistogram(name, val) {
            recorded.push([name, val]);
          },
        },
      },
    );
    expect(recorded.find(([n]) => n === 'context_assembly.duration_ms')).toBeDefined();
  });

  it('history loader failure → degrades to empty turns', async () => {
    const { builders } = makeStandardBuilders();
    const packet = await buildContextPacket(
      { base: mockBase(), decision: mockDecision() },
      {
        builders,
        historyLoader: async () => {
          throw new Error('history backend down');
        },
      },
    );
    expect(packet.history.turns).toEqual([]);
    expect(packet.assembly_meta.fallback_depths_applied.history).toBe('degraded');
  });
});

