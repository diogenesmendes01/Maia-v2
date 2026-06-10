/**
 * @stub P8a stub for DecisionPacket producer.
 *
 * P9b shipped the real Decision Engine (`src/runtime/decision/`, wired to the
 * hot path in #152), so production no longer consumes this stub — it survives
 * only as a fixture for orchestrator/slice-builder tests
 * (tests/unit/runtime/context-packet/).
 */

import type { BaseContextPacket, DecisionPacket } from './types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from './types.js';

export function createDecisionPacketStub(base: BaseContextPacket): DecisionPacket {
  return {
    trace_id: base.trace_id,
    intent: {
      label: 'default_flow',
      confidence: 0.5,
      alternatives: [],
    },
    risk_profile: {
      level: 'low',
      reasons: [],
      requires_human_review: false,
    },
    routing: {
      agent_id: base.agent_id,
      candidate_skill_ids: [],
    },
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
    rationale: 'P8a stub: conservative defaults (P9b replaces with real Decision Engine)',
  };
}
