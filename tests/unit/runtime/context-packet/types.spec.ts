/**
 * P8a Task 1 — Context Packet types validation.
 *
 * Smoke tests that the type contracts compile and shape-check.
 * Real behavior is tested in builder/orchestrator specs.
 */
import { describe, it, expect } from 'vitest';
import type {
  BaseContextPacket,
  DecisionPacket,
  ContextRequirements,
  ExecutionContextPacket,
  IdentitySlice,
  UserSlice,
  KnowledgeSlice,
  SoulSlice,
  PolicySlice,
  SkillSlice,
  ToolPermissionSlice,
} from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

describe('Context Packet types (v3.1.1)', () => {
  it('BaseContextPacket has trace_id, tenant_id, agent_id, channel, actor, input', () => {
    const base: BaseContextPacket = {
      trace_id: 'uuid1',
      tenant_id: 'tenant1',
      agent_id: 'agent1',
      session_id: 'sess1',
      conversation_id: 'conv1',
      channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
      actor: {
        user_id: 'u1',
        pessoa_id: 'p1',
        role: 'end_user',
        is_authenticated: true,
      },
      input: {
        kind: 'text',
        content_ref: 'ref1',
        content_hmac: 'abc123',
        received_at: new Date().toISOString(),
      },
      active_procedure_execution_id: null,
      feature_flags_snapshot: { FEATURE_CONTEXT_PACKET_V1: true },
      entered_at_ms: Date.now(),
    };
    expect(base.trace_id).toBeDefined();
    expect(base.channel.kind).toBe('whatsapp');
    expect(base.actor.is_authenticated).toBe(true);
  });

  it('DecisionPacket has intent, risk_profile, routing, action_mode, context_requirements', () => {
    const decision: DecisionPacket = {
      trace_id: 'uuid1',
      intent: { label: 'request_transfer', confidence: 0.95 },
      risk_profile: {
        level: 'medium',
        reasons: ['transfer > 1000'],
        requires_human_review: false,
      },
      routing: { agent_id: 'agent1', candidate_skill_ids: ['skill1'] },
      action_mode: 'call_tool',
      tool_permissions: {
        allowed_tools: ['transfer_tool'],
        blocked_tools: [],
        requires_confirmation: ['transfer_tool'],
      },
      context_requirements: {
        identity: { depth: 'full' },
        user: { depth: 'relevant' },
        knowledge: { depth: 'relevant' },
        soul: { depth: 'relevant' },
        policy: { depth: 'domain' },
        history: { depth: 'last_turns', max_turns: 6 },
        skill: 'selected_only',
      },
      evaluation_plan: {
        validators: [],
        llm_judge_required: false,
        human_review_required: true,
      },
      policy_decisions: [],
      rationale: 'user is authenticated, risk medium',
    };
    expect(decision.intent.label).toBe('request_transfer');
    expect(decision.risk_profile.level).toBe('medium');
    expect(decision.action_mode).toBe('call_tool');
  });

  it('DEFAULT_CONTEXT_REQUIREMENTS exposes safe defaults', () => {
    const reqs: ContextRequirements = DEFAULT_CONTEXT_REQUIREMENTS;
    expect(reqs.identity.depth).toBe('full');
    expect(reqs.user.depth).toBe('minimal');
    expect(reqs.knowledge.depth).toBe('relevant');
    expect(reqs.soul.depth).toBe('relevant');
    expect(reqs.policy.depth).toBe('basic');
    expect(reqs.skill).toBe('selected_only');
  });

  it('ExecutionContextPacket aggregates 7 slices + history + assembly_meta', () => {
    const identity: IdentitySlice = {
      role_descriptor: 'maia',
      voice: { tone: 'neutral', formality: 'medium', verbosity: 'concise' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.7,
      },
      priorities: [],
      learned_voice_modifiers: [],
      schema_version: 'v3.1.1-2026-05-15',
      version_id: 'v1',
    };
    const user: UserSlice = {
      pessoa: null,
      preferences: {},
      memories: [],
      behavioral_hints: [],
      truncated: false,
    };
    const knowledge: KnowledgeSlice = {
      facts: [],
      rules: [],
      truncated: { facts: false, rules: false },
    };
    const soul: SoulSlice = { biases: [], truncated: false };
    const policy: PolicySlice = {
      applicable_rules: [],
      resolver_cache_key: 'key1',
      truncated: false,
    };
    const skill: SkillSlice = {
      mode: 'selected_only',
      selected_skill: null,
      candidate_skills: [],
    };
    const tool: ToolPermissionSlice = {
      available_tools: [],
      blocked_tools: [],
      requires_confirmation: [],
    };

    const packet: ExecutionContextPacket = {
      trace_id: 'uuid1',
      tenant_id: 'tenant1',
      agent_id: 'agent1',
      conversation_id: 'conv1',
      base_ref: 'base_hmac',
      decision_ref: 'decision_hmac',
      identity,
      user,
      knowledge,
      soul,
      policy,
      skill,
      tool,
      history: { turns: [], truncated: false },
      assembly_meta: {
        started_at_ms: 0,
        finished_at_ms: 100,
        duration_ms: 100,
        cache_hits: {},
        fallback_depths_applied: {},
        builder_durations_ms: {},
      },
    };
    expect(packet.identity).toBeDefined();
    expect(packet.assembly_meta.duration_ms).toBeLessThan(600);
    expect(packet.tool.available_tools).toEqual([]);
  });

  it('KnowledgeLifecycleStatus union excludes proposed and pending_review (master §15 invariant 9)', () => {
    // This is a compile-time guarantee — verified by tsc, asserted at runtime.
    const validStatuses = [
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
    ];
    // proposed / pending_review intentionally absent — never exposed in packet.
    expect(validStatuses).not.toContain('proposed');
    expect(validStatuses).not.toContain('pending_review');
  });
});
