/**
 * P8a — Context Packet types (BaseContextPacket, DecisionPacket, 7 slices, ExecutionContextPacket).
 *
 * Spec: docs/superpowers/specs/2026-05-15-p8a-context-packet-design.md §2.
 * Plan: docs/superpowers/plans/2026-05-15-p8a-context-packet.md Task 1.
 *
 * Camada 1 (Entry & Context) → BaseContextPacket
 * Camada 2 (Decision Engine) → DecisionPacket (P8a entrega tipo + stub; real em P9b)
 * Camada 3 (Context Assembly) → ExecutionContextPacket (7 slices + history + assembly_meta)
 */

// ============================================================================
// BaseContextPacket — Camada 1
// ============================================================================

export interface BaseContextPacket {
  trace_id: string; // UUID gerado no entry
  tenant_id: string;
  agent_id: string;
  session_id: string;
  conversation_id: string;
  channel: {
    id: string;
    kind: 'whatsapp' | 'web' | 'api' | 'admin';
    is_locked_down: boolean;
  };
  actor: {
    user_id: string | null;
    pessoa_id: string | null;
    role: string;
    is_authenticated: boolean;
  };
  input: {
    kind: 'text' | 'audio' | 'image' | 'pdf' | 'tool_result';
    content_ref: string;
    content_hmac: string;
    received_at: string;
  };
  active_procedure_execution_id: string | null;
  feature_flags_snapshot: Record<string, boolean>;
  entered_at_ms: number;
}

// ============================================================================
// DecisionPacket — Camada 2 (tipo em P8a; producer real em P9b)
// ============================================================================

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
  soul: {
    depth: 'none' | 'relevant';
    max_biases?: number;
  };
  policy: {
    depth: 'basic' | 'domain' | 'risk';
    max_rules?: number;
  };
  history: {
    depth: 'none' | 'last_turns' | 'relevant';
    max_turns?: number;
    max_tokens_hint?: number;
  };
  skill: 'selected_only' | 'candidates';
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
    pep: 'early' | 'mid';
    policy_id: string;
    rule_descriptor: string;
    decision: PolicyDecision;
    reason: string;
  }>;
  rationale: string;
}

// ============================================================================
// Slice types — consumidos pelo ExecutionContextPacket
// ============================================================================

export type KnowledgeLifecycleStatus =
  | 'ephemeral'
  | 'observed'
  | 'reinforced'
  | 'verified'
  | 'active';

export interface IdentitySlice {
  role_descriptor: string;
  voice: { tone: string; formality: string; verbosity: string };
  cognitive_limits: {
    max_inference_depth: number;
    max_speculation_in_response: number;
    confidence_floor_for_action: number;
  };
  priorities: string[];
  learned_voice_modifiers: Array<{
    aspect: string;
    modifier: string;
    strength: number;
  }>;
  schema_version: string;
  version_id: string;
}

export interface UserSlice {
  pessoa: { id: string; display_name: string | null; locale: string } | null;
  preferences: Record<string, unknown>;
  memories: Array<{
    id: string;
    kind: string;
    content: string;
    confidence: number;
    scope: string;
    sensitivity: string;
    proactive_use: boolean;
  }>;
  behavioral_hints: Array<{
    aspect: string;
    suggestion: string;
    strength: number;
  }>;
  truncated: boolean;
}

export interface KnowledgeSlice {
  facts: Array<{
    key: string;
    value: unknown;
    scope: 'global' | 'tenant' | 'domain' | 'entity';
    confidence: number;
    source: string;
    lifecycle_status: KnowledgeLifecycleStatus;
  }>;
  rules: Array<{
    id: string;
    context: string;
    action: string;
    confidence: number;
    lifecycle_status: KnowledgeLifecycleStatus;
  }>;
  truncated: { facts: boolean; rules: boolean };
}

export interface SoulSlice {
  biases: Array<{
    id: string;
    principle: string;
    strength: number;
    origin: string;
    scope: string;
    scope_value: string | null;
    version_id: string;
  }>;
  truncated: boolean;
}

export type PolicyRuleKind =
  | 'hard_limit'
  | 'soft_guidance'
  | 'dual_approval'
  | 'lockdown_trigger';

export interface PolicySlice {
  applicable_rules: Array<{
    policy_id: string;
    version: number;
    rule_descriptor: string;
    rule_kind: PolicyRuleKind;
    applies_to_peps: Array<'early' | 'mid' | 'late'>;
    rule_body_ref: string;
  }>;
  resolver_cache_key: string;
  truncated: boolean;
}

export interface SkillSlice {
  mode: 'selected_only' | 'candidates';
  selected_skill: {
    id: string;
    name: string;
    version: number;
    input_schema_ref: string;
    output_schema_ref: string;
    procedure_ref: string;
    constraints: Record<string, unknown>;
    success_criteria: Record<string, unknown>;
    runtime_hints: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_tool_calls?: number;
      allow_deep_context?: boolean;
      preferred_model?: string;
    };
  } | null;
  candidate_skills: Array<{ id: string; name: string; reason: string }>;
}

export interface ToolPermissionSlice {
  available_tools: Array<{
    name: string;
    side_effect_level: 'none' | 'low' | 'medium' | 'high';
    requires_confirmation: boolean;
    idempotent: boolean;
    audit_level: 'standard' | 'high';
    timeout_ms: number;
  }>;
  blocked_tools: string[];
  requires_confirmation: string[];
}

export interface HistorySlice {
  turns: Array<{
    role: 'user' | 'agent' | 'tool';
    content: string;
    ts: string;
  }>;
  truncated: boolean;
}

// ============================================================================
// SliceName — discriminator + ExecutionContextPacket
// ============================================================================

export type SliceName =
  | 'identity'
  | 'user'
  | 'knowledge'
  | 'soul'
  | 'policy'
  | 'skill'
  | 'tool'
  | 'history';

export interface AssemblyMeta {
  started_at_ms: number;
  finished_at_ms: number;
  duration_ms: number;
  cache_hits: Partial<Record<SliceName, boolean>>;
  fallback_depths_applied: Partial<Record<SliceName, string>>;
  builder_durations_ms: Partial<Record<SliceName, number>>;
}

export interface ExecutionContextPacket {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  conversation_id: string;
  base_ref: string;
  decision_ref: string;
  identity: IdentitySlice;
  user: UserSlice;
  knowledge: KnowledgeSlice;
  soul: SoulSlice;
  policy: PolicySlice;
  skill: SkillSlice;
  tool: ToolPermissionSlice;
  history: HistorySlice;
  assembly_meta: AssemblyMeta;
}
