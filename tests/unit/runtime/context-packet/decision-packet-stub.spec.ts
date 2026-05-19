/**
 * P8a Task 3 — DecisionPacketStub shape tests.
 *
 * Stub producer must yield a valid DecisionPacket with conservative defaults.
 * Real producer lands in P9b.
 */
import { describe, it, expect } from 'vitest';
import { createDecisionPacketStub } from '@/runtime/context-packet/decision-packet-stub.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

const mockBase = (trace_id = 'uuid1'): BaseContextPacket => ({
  trace_id,
  tenant_id: 'tenant1',
  agent_id: 'agent1',
  session_id: 'sess1',
  conversation_id: 'conv1',
  channel: { id: 'ch1', kind: 'api', is_locked_down: false },
  actor: {
    user_id: 'u1',
    pessoa_id: 'p1',
    role: 'end_user',
    is_authenticated: true,
  },
  input: {
    kind: 'text',
    content_ref: 'ref1',
    content_hmac: 'hmac1',
    received_at: new Date().toISOString(),
  },
  active_procedure_execution_id: null,
  feature_flags_snapshot: {},
  entered_at_ms: Date.now(),
});

describe('DecisionPacketStub (P8a)', () => {
  it('produces valid DecisionPacket shape with conservative defaults', () => {
    const base = mockBase();
    const decision = createDecisionPacketStub(base);

    expect(decision.trace_id).toBe(base.trace_id);
    expect(decision.intent.label).toBeTruthy();
    expect(decision.intent.confidence).toBeGreaterThan(0);
    expect(decision.intent.confidence).toBeLessThanOrEqual(1);
    expect(decision.risk_profile.level).toBe('low');
    expect(decision.risk_profile.requires_human_review).toBe(false);
    expect(decision.action_mode).toBe('respond');
    expect(decision.routing.agent_id).toBe(base.agent_id);
    expect(decision.routing.candidate_skill_ids).toEqual([]);
  });

  it('exposes safe context_requirements defaults', () => {
    const decision = createDecisionPacketStub(mockBase());
    expect(decision.context_requirements.identity.depth).toBe('full');
    expect(decision.context_requirements.user.depth).toBe('minimal');
    expect(decision.context_requirements.knowledge.depth).toBe('relevant');
    expect(decision.context_requirements.soul.depth).toBe('relevant');
    expect(decision.context_requirements.policy.depth).toBe('basic');
    expect(decision.context_requirements.skill).toBe('selected_only');
  });

  it('starts with no tool permissions (zero-trust default)', () => {
    const decision = createDecisionPacketStub(mockBase());
    expect(decision.tool_permissions.allowed_tools).toEqual([]);
    expect(decision.tool_permissions.blocked_tools).toEqual([]);
    expect(decision.tool_permissions.requires_confirmation).toEqual([]);
  });

  it('carries P8a-stub marker in rationale', () => {
    const decision = createDecisionPacketStub(mockBase());
    expect(decision.rationale.toLowerCase()).toMatch(/stub|p8a|p9b/);
  });

  it('preserves trace_id across calls (one decision per turn)', () => {
    const base = mockBase('trace-XYZ');
    const decision = createDecisionPacketStub(base);
    expect(decision.trace_id).toBe('trace-XYZ');
  });
});
