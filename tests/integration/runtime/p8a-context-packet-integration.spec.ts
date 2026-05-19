/**
 * P8a Task 15 — Context Packet end-to-end integration tests.
 *
 * Covers:
 *  - 50-tenant fixture with p95 budget assertion
 *  - cache hits on second call for stable slices
 *  - event invalidation forces miss
 *  - all 7 slices + history rendered together
 *  - kill switch disables flag
 *  - prompt-from-packet renders end-to-end
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildContextPacket } from '@/runtime/context-packet/build-context-packet.js';
import type { SliceBuilderSet } from '@/runtime/context-packet/build-context-packet.js';
import { IdentitySliceBuilder } from '@/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import { UserSliceBuilder } from '@/runtime/context-assembly/slice-builders/user-slice-builder.js';
import { KnowledgeSliceBuilder } from '@/runtime/context-assembly/slice-builders/knowledge-slice-builder.js';
import {
  SoulSliceBuilder,
  stubSoulPort,
} from '@/runtime/context-assembly/slice-builders/soul-slice-builder.js';
import {
  PolicySliceBuilder,
  stubPolicyDescriptorResolver,
} from '@/runtime/context-assembly/slice-builders/policy-slice-builder.js';
import { SkillSliceBuilder } from '@/runtime/context-assembly/slice-builders/skill-slice-builder.js';
import { ToolPermissionSliceBuilder } from '@/runtime/context-assembly/slice-builders/tool-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import {
  InvalidationBus,
  wireDefaultInvalidationHandlers,
} from '@/runtime/context-packet/cache/invalidation-bus.js';
import { isContextPacketV1Enabled } from '@/runtime/feature-flags/context-packet-flag.js';
import { buildPromptFromPacket } from '@/runtime/prompt/build-prompt-from-packet.js';
import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

function mkBuilders(cache: InMemorySliceCache): SliceBuilderSet {
  const identity = new IdentitySliceBuilder(
    {
      async getActive(tenant_id, agent_id) {
        return {
          id: `profile-${tenant_id}-${agent_id}`,
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
              priorities: ['p1'],
            },
          },
        };
      },
    },
    cache,
  );
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
    identity: identity as unknown as SliceBuilderSet['identity'],
    user: user as unknown as SliceBuilderSet['user'],
    knowledge: knowledge as unknown as SliceBuilderSet['knowledge'],
    soul: soul as unknown as SliceBuilderSet['soul'],
    policy: policy as unknown as SliceBuilderSet['policy'],
    skill: skill as unknown as SliceBuilderSet['skill'],
    tool: tool as unknown as SliceBuilderSet['tool'],
  };
}

function mkBase(tenant_id: string, agent_id = 'agent1'): BaseContextPacket {
  return {
    trace_id: `trace-${tenant_id}`,
    tenant_id,
    agent_id,
    session_id: 's1',
    conversation_id: `conv-${tenant_id}`,
    channel: { id: 'ch1', kind: 'api', is_locked_down: false },
    actor: {
      user_id: 'u1',
      pessoa_id: 'p1',
      role: 'end_user',
      is_authenticated: true,
    },
    input: {
      kind: 'text',
      content_ref: 'r1',
      content_hmac: 'h1',
      received_at: new Date().toISOString(),
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: { FEATURE_CONTEXT_PACKET_V1: true },
    entered_at_ms: 0,
  };
}

function mkDecision(): DecisionPacket {
  return {
    trace_id: 't',
    intent: { label: 'x', confidence: 0.8 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: { agent_id: 'agent1', candidate_skill_ids: [] },
    action_mode: 'respond',
    tool_permissions: {
      allowed_tools: [],
      blocked_tools: [],
      requires_confirmation: [],
    },
    context_requirements: { ...DEFAULT_CONTEXT_REQUIREMENTS },
    evaluation_plan: {
      validators: [],
      llm_judge_required: false,
      human_review_required: false,
    },
    policy_decisions: [],
    rationale: 'test',
  };
}

describe('P8a Context Packet — end-to-end integration', () => {
  let cache: InMemorySliceCache;
  let builders: SliceBuilderSet;

  beforeEach(() => {
    cache = new InMemorySliceCache();
    builders = mkBuilders(cache);
  });

  it('builds 50-tenant fixture with p95 <600ms', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const tenant = `tenant_${i}`;
      const packet = await buildContextPacket(
        { base: mkBase(tenant), decision: mkDecision() },
        {
          builders,
          historyLoader: async () => ({ turns: [], truncated: false }),
        },
      );
      durations.push(packet.assembly_meta.duration_ms);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(600);
  });

  it('second call hits cache for identity/policy/soul', async () => {
    const base = mkBase('t1');
    const decision = mkDecision();

    const p1 = await buildContextPacket(
      { base, decision },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(p1.assembly_meta.cache_hits.identity).toBe(false);
    expect(p1.assembly_meta.cache_hits.policy).toBe(false);
    expect(p1.assembly_meta.cache_hits.soul).toBe(false);

    const p2 = await buildContextPacket(
      { base, decision },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(p2.assembly_meta.cache_hits.identity).toBe(true);
    expect(p2.assembly_meta.cache_hits.policy).toBe(true);
    expect(p2.assembly_meta.cache_hits.soul).toBe(true);
  });

  it('policy_rule_activated event invalidates policy cache (next call misses)', async () => {
    const bus = new InvalidationBus();
    wireDefaultInvalidationHandlers(bus, cache);
    const base = mkBase('t1');
    const decision = mkDecision();

    // Prime cache
    const p1 = await buildContextPacket(
      { base, decision },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(p1.assembly_meta.cache_hits.policy).toBe(false);

    const p2 = await buildContextPacket(
      { base, decision },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(p2.assembly_meta.cache_hits.policy).toBe(true);

    // Invalidation event
    await bus.dispatch({
      type: 'policy_rule_activated',
      tenant_id: 't1',
      occurred_at: new Date().toISOString(),
    });

    // Next call → miss on policy
    const p3 = await buildContextPacket(
      { base, decision },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(p3.assembly_meta.cache_hits.policy).toBe(false);
    // Other slices still hit cache (only policy was invalidated)
    expect(p3.assembly_meta.cache_hits.identity).toBe(true);
  });

  it('packet shape covers all 7 slices + history', async () => {
    const packet = await buildContextPacket(
      { base: mkBase('t1'), decision: mkDecision() },
      {
        builders,
        historyLoader: async () => ({ turns: [], truncated: false }),
      },
    );
    expect(packet.identity).toBeDefined();
    expect(packet.user).toBeDefined();
    expect(packet.knowledge).toBeDefined();
    expect(packet.soul).toBeDefined();
    expect(packet.policy).toBeDefined();
    expect(packet.skill).toBeDefined();
    expect(packet.tool).toBeDefined();
    expect(packet.history).toBeDefined();
  });

  it('kill switch disables flag globally', async () => {
    const result = await isContextPacketV1Enabled('t1', {
      getEnv(name) {
        if (name === 'FEATURE_CONTEXT_PACKET_V1') return 'true';
        if (name === 'FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH') return 'true';
        return undefined;
      },
    });
    expect(result).toBe(false);
  });

  it('packet renders into prompt via buildPromptFromPacket', async () => {
    const packet = await buildContextPacket(
      { base: mkBase('t1'), decision: mkDecision() },
      {
        builders,
        historyLoader: async () => ({
          turns: [
            { role: 'user', content: 'oi', ts: '2025-01-01T00:00:00Z' },
            { role: 'agent', content: 'olá', ts: '2025-01-01T00:00:01Z' },
          ],
          truncated: false,
        }),
      },
    );
    const prompt = buildPromptFromPacket(packet);
    expect(prompt.system).toContain('## Identidade operacional');
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]).toEqual({ role: 'user', content: 'oi' });
  });
});
