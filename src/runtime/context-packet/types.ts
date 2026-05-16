/**
 * P9b — Local stub types for context packet.
 *
 * TODO(P8a #96): Replace with full BaseContextPacket / DecisionPacket from P8a
 * once that PR merges. Current shape is the minimal subset required by P9b.
 *
 * The DecisionPacket type below is the **full** P9b shape (replaces the
 * conservative `DecisionPacketStub` from P8a). See spec §2.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export type ActionMode =
  | 'respond'
  | 'ask_clarification'
  | 'call_tool'
  | 'escalate'
  | 'continue_workflow';

export type PolicyDecision =
  | 'allow'
  | 'block'
  | 'warn'
  | 'require_dual_approval'
  | 'escalate';

/** Late is included for completeness (spec §2 "P8a stub had early|mid only"). */
export type PepKind = 'early' | 'mid' | 'late';

export interface ChannelInfo {
  id: string;
  kind: string;
  is_locked_down: boolean;
}

export interface ActorInfo {
  id: string;
  is_authenticated: boolean;
  display_name?: string;
}

export interface InputInfo {
  /** Reference to message content (resolved lazily by contentResolver). */
  content_ref: string;
  /** When the inbound was received. */
  received_at: Date;
  /** Optional content hmac for replay detection. */
  content_hmac?: string;
}

/**
 * Base context packet (Camada 1 output).
 *
 * TODO(P8a #96): Replace with full BaseContextPacket from
 * `src/runtime/context-packet/types.ts` once P8a merges. P8a will add many
 * more fields (assembly_meta, identity references, etc.) but the subset below
 * is sufficient for Decision Engine.
 */
export interface BaseContextPacket {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  channel: ChannelInfo;
  actor: ActorInfo;
  input: InputInfo;
  active_procedure_execution_id?: string;
}

export interface ContextRequirements {
  identity: { depth: 'minimal' | 'full' };
  user: {
    depth: 'none' | 'minimal' | 'relevant' | 'deep';
    max_items?: number;
    max_tokens_hint?: number;
  };
  knowledge: {
    depth: 'none' | 'relevant' | 'deep';
    max_facts?: number;
    max_rules?: number;
    max_tokens_hint?: number;
  };
  soul: { depth: 'none' | 'relevant'; max_biases?: number };
  policy: { depth: 'basic' | 'domain' | 'risk'; max_rules?: number };
  history: {
    depth: 'none' | 'last_turns' | 'relevant';
    max_turns?: number;
    max_tokens_hint?: number;
  };
  skill: 'selected_only' | 'candidates';
}

export interface KnowledgeProposalRequest {
  kind: 'fact' | 'rule' | 'memory' | 'hint';
  payload: Record<string, unknown>;
  confidence: number;
  source: 'classifier' | 'mid_pep' | 'action_decider';
}

export interface DecisionPacket {
  trace_id: string;
  intent: { label: string; confidence: number; alternatives?: string[] };
  risk_profile: {
    level: RiskLevel;
    reasons: string[];
    requires_human_review: boolean;
  };
  routing: {
    workflow_id?: string;
    agent_id: string;
    selected_skill_id?: string;
    candidate_skill_ids: string[];
  };
  action_mode: ActionMode;
  tool_permissions: {
    allowed_tools: string[];
    blocked_tools: string[];
    requires_confirmation: string[];
  };
  context_requirements: ContextRequirements;
  evaluation_plan: {
    validators: string[];
    llm_judge_required: boolean;
    human_review_required: boolean;
  };
  policy_decisions: Array<{
    pep: PepKind;
    policy_id: string;
    rule_descriptor: string;
    decision: PolicyDecision;
    reason: string;
  }>;
  requested_knowledge_proposals?: Array<KnowledgeProposalRequest>;
  rationale: string;
}

export const DEFAULT_CONTEXT_REQUIREMENTS: ContextRequirements = {
  identity: { depth: 'full' },
  user: { depth: 'minimal', max_items: 5 },
  knowledge: { depth: 'relevant', max_facts: 10, max_rules: 5 },
  soul: { depth: 'relevant', max_biases: 5 },
  policy: { depth: 'basic', max_rules: 20 },
  history: { depth: 'last_turns', max_turns: 6 },
  skill: 'selected_only',
};
