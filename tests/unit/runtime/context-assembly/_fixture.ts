/**
 * P8a — Shared test fixtures for slice builders and orchestrator.
 *
 * mockBase / mockDecision produce sensible defaults. Overrides allow specs to
 * tweak just what they care about.
 */
import type {
  BaseContextPacket,
  DecisionPacket,
} from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

export const mockBase = (
  overrides?: Partial<BaseContextPacket>,
): BaseContextPacket => ({
  trace_id: 'uuid1',
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
  feature_flags_snapshot: { FEATURE_CONTEXT_PACKET_V1: true },
  entered_at_ms: Date.now(),
  ...overrides,
});

export const mockDecision = (
  overrides?: Partial<DecisionPacket>,
): DecisionPacket => ({
  trace_id: 'uuid1',
  intent: { label: 'test', confidence: 0.9 },
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
  ...overrides,
});
