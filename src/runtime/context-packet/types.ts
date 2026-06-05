/**
 * P8a — Context Packet types (BaseContextPacket, DecisionPacket, 7 slices, ExecutionContextPacket).
 *
 * Spec: docs/superpowers/specs/2026-05-15-p8a-context-packet-design.md §2.
 * Plan: docs/superpowers/plans/2026-05-15-p8a-context-packet.md Task 1.
 *
 * Camada 1 (Entry & Context) → BaseContextPacket
 * Camada 2 (Decision Engine) → DecisionPacket (P8a entregou tipo + stub; P9b
 *   substitui pela versão real, incluindo `PepKind` (early|mid|late),
 *   `KnowledgeProposalRequest` e `requested_knowledge_proposals`).
 * Camada 3 (Context Assembly) → ExecutionContextPacket (7 slices + history + assembly_meta)
 */

import type { AudienceType, TrustLevel } from '@/shared/audience.js';

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
    /**
     * Issue #407: per-agent audience attribution, derived from the resolver's
     * `AudienceContext` (`agent_audience_profiles` relation). Governance-derived
     * (invariant #3) — never declared by the LLM. Optional + nullable so the
     * many existing `actor` construction sites keep compiling; the runtime
     * wiring that threads `AudienceContext` into the packet lands downstream
     * (#410). `null` = not yet resolved / no active audience profile.
     */
    audience_type?: AudienceType | null;
    trust_level?: TrustLevel | null;
  };
  input: {
    kind: 'text' | 'audio' | 'image' | 'pdf' | 'tool_result';
    content_ref: string;
    content_hmac: string;
    received_at: string;
  };
  active_procedure_execution_id: string | null;
  /**
   * Issue #415/#416 — the turn's ACTIVE operational role key, resolved by the
   * role-selector chain (`src/cognition/role-selector/`; LLM suggests, policy
   * decides — taxonomy §3). This is NOT `actor.role` (which describes WHO is
   * speaking); it is the agent's operational MODE for this turn. The Decision
   * Engine threads it into the SkillSelector as `active_role_key` so the role →
   * skill scope (`applicable_to_role`, taxonomy §2 step 5) admits a role-bound
   * skill only on a matching role. Absent/undefined ⇒ role-agnostic turn (or the
   * role-selector did not run): role-bound skills are not selected (fail-closed);
   * skills with an empty `applicable_to_role` remain universal.
   */
  active_role_key?: string;
  feature_flags_snapshot: Record<string, boolean>;
  entered_at_ms: number;
  /**
   * Count of active sensitive memories visible to this turn (user-layer scope).
   * Used by RiskScorer P9c to derive a risk floor — many sensitive memories
   * = higher risk surface. Always >= 0.
   */
  active_sensitive_memory_count: number;
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
  | 'continue_workflow'
  // F1 Phase 1: a selected skill whose execution_mode is terminal + side-effect
  // free (`prompt_only` | `evaluator`) is executed directly via `runSkill` at
  // the core.ts call site. Side-effecting modes (`tool_mediated` /
  // `procedure_adapter`) are explicitly NOT routed here — they remain Phase 2.
  | 'execute_skill';
export type PolicyDecision =
  | 'allow'
  | 'block'
  | 'warn'
  | 'require_dual_approval'
  | 'escalate';

/**
 * P9b: PEP discriminator. P8a originally stubbed only `early|mid`; the Late
 * PEP completes the trio per spec §2.
 */
export type PepKind = 'early' | 'mid' | 'late';

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

/**
 * P9b: knowledge proposals requested by classifier/mid_pep/action_decider,
 * persisted by the Decision Engine for later async classification.
 */
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
    /**
     * F1 Phase 1 (Codex HIGH/P2 — immutable identity): the selected skill's
     * stable descriptor + version, pinned at decision time. The execute_skill
     * call site re-resolves the active skill by descriptor under the routed
     * agent and asserts the freshly-read `id`/`version` still equal these
     * pinned values before executing — otherwise an activate/rollback race (or
     * routed-agent mismatch) could execute a *different* skill than the engine
     * evaluated. Present only when a skill was selected.
     */
    selected_skill_descriptor?: string;
    selected_skill_version?: number;
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
  /**
   * P8a structural modifiers (legacy/loose shape) used by main's class-based
   * IdentitySliceBuilder. P8d also surfaces `active_voice_modifiers` below
   * with the strongly-typed `LearnedVoiceModifier` shape from
   * `@/identity/learned-voice-modifier`.
   */
  learned_voice_modifiers: Array<{
    aspect: string;
    modifier: string;
    strength: number;
  }>;
  schema_version: string;
  version_id: string;

  // P8d §5 — extra optional fields populated by `buildIdentitySlice()`.
  // Optional so existing callers (P8a class) keep compiling.
  identity_block?: string;
  principles?: string[]; // only when depth='full' and data has them
  active_voice_modifiers?: unknown[]; // only when depth='full' and ≥1 active
  version_number?: number;
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

/**
 * SoulSlice — re-exported from p8b's canonical location.
 *
 * P8a originally shipped a stub `{ biases, truncated }` shape. P8b replaces it
 * with the richer real shape `{ active_biases, rendered_block, total_active,
 * truncated_to, cache_key, resolved_at }` defined in
 * `src/runtime/context-assembly/types/soul-slice.ts`.
 */
import type {
  SoulSlice,
  SoulSliceBias,
} from '../context-assembly/types/soul-slice.js';
export type { SoulSlice, SoulSliceBias };

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
  | 'history'
  // Issue #407: per-agent audience slice. Cache-scoped by
  // (tenant_id, agent_id, contact_id). Not yet assembled into the
  // ExecutionContextPacket (that wiring is #410); registered here so the
  // slice cache key + TTL + invalidation machinery treat it uniformly.
  | 'audience';

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
