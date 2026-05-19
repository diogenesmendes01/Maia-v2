/**
 * @stub P8a production stub for DecisionPacket producer.
 * Replaced by real Decision Engine in P9b (intent classifier, risk scorer,
 * policy evaluator early PEP).
 *
 * P8a entrega apenas o TYPE + este stub para permitir testes end-to-end do
 * orchestrator/slice builders sem depender de P9b.
 *
 * TODO(P9b): replace with real Decision Engine.
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
