/**
 * P10a — Knowledge State Machine types.
 *
 * Single source of truth for the 9-state lifecycle and the
 * `KnowledgeStateMachine.propose / transition / revoke` API shape.
 *
 * Architecture Lock (master §0.1): changes to KnowledgeLifecycleStatus
 * union or the decided_by union require founder approval (CODEOWNERS).
 */

export type KnowledgeKind =
  | 'fact'
  | 'rule'
  | 'memory'
  | 'behavioral_hint'
  | 'procedure_hint';

export type KnowledgeScope =
  | 'turn'
  | 'session'
  | 'user'
  | 'agent'
  | 'tenant'
  | 'global';

/**
 * 9-state lifecycle. Order in this union mirrors §3.1 of the spec.
 * The LLM only ever sees the 5 middle states (ephemeral..active).
 * 'proposed' is a transit-only state; rows never persist with it.
 */
export type KnowledgeLifecycleStatus =
  | 'proposed'
  | 'pending_review'
  | 'ephemeral'
  | 'observed'
  | 'reinforced'
  | 'verified'
  | 'active'
  | 'deprecated'
  | 'revoked';

export type KnowledgeOrigin =
  | 'llm_inference'
  | 'user_explicit'
  | 'tool_callback'
  | 'human_approved';

export type KnowledgeSensitivity = 'low' | 'medium' | 'high';

export type KnowledgeRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Decision authority recorded on every lifecycle transition.
 * 'idempotent' is reserved for KnowledgeStateMachine.revoke() called on
 * an already-revoked row (no-op return).
 */
export type KnowledgeDecidedBy =
  | 'state_machine_propose'
  | 'auto_promoter:evidence_threshold'
  | 'auto_promoter:ttl_expired'
  | 'auto_promoter:no_usage_90d'
  | 'auto_promoter:maturity_threshold'
  | 'human_approval'
  | 'human_rejection'
  | 'incident_response'
  | 'drift_decision'
  | 'contraevidence'
  | 'idempotent';

/**
 * Per-kind table-native fields the KSM facade must write verbatim into
 * the legacy columns. Without this carrier the facade silently coerced
 * everything to generic scope strings and lost subject_id / role /
 * channel / interlocutor — making proposed rows un-findable by the
 * legacy read paths (Codex round-2 finding 2).
 *
 * Every field is optional; callers fill the ones their kind expects:
 *   - fact  → `fact_escopo`, `fact_chave` (e.g. `pessoa:<uuid>` / `entidade:<uuid>`).
 *   - rule  → `rule_tipo`, `rule_contexto`, `rule_acao`, `rule_contexto_jsonb`,
 *             `rule_acoes_jsonb`.
 *   - memory → `memory_scope_type`, `memory_subject_id`, `memory_type`,
 *              `memory_interlocutor_id`, `memory_conversa_id`,
 *              `memory_sensitivity`, `memory_proactive_use`,
 *              `memory_mention_allowed`.
 *   - behavioral_hint / procedure_hint → `hint_scope_type`,
 *              `hint_subject_id`, `hint_derived_sensitivity`,
 *              `hint_derived_from_memory_id`.
 */
export interface KnowledgeProposalNativeFields {
  // fact
  fact_escopo?: string;
  fact_chave?: string;

  // rule
  rule_tipo?:
    | 'classificacao'
    | 'identificacao_entidade'
    | 'tom_resposta'
    | 'recorrencia';
  rule_contexto?: string;
  rule_acao?: string;
  rule_contexto_jsonb?: Record<string, unknown>;
  rule_acoes_jsonb?: Record<string, unknown>;

  // memory
  memory_type?: string;
  memory_scope_type?: 'interlocutor' | 'role' | 'channel' | 'conversation' | 'agent' | 'tenant';
  memory_subject_id?: string | null;
  memory_interlocutor_id?: string | null;
  memory_conversa_id?: string | null;
  memory_sensitivity?: 'low' | 'medium' | 'high' | 'sensitive';
  memory_proactive_use?: boolean;
  memory_mention_allowed?: boolean;

  // hint
  hint_scope_type?: 'interlocutor' | 'role' | 'channel' | 'conversation' | 'agent' | 'tenant';
  hint_subject_id?: string | null;
  hint_derived_sensitivity?: 'low' | 'medium' | 'high';
  hint_derived_from_memory_id?: string | null;
}

export interface KnowledgeProposalInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  scope_value?: string;
  key: string;
  content: unknown;
  content_text: string;
  confidence: number;
  origin: KnowledgeOrigin;
  source: string;
  sensitivity_hint?: KnowledgeSensitivity;
  ttl_days?: number;
  /**
   * Codex round-2 finding 2: table-native column values the legacy
   * read paths (factsRepo.listForScopes, memoryEntryRepo.findRelevant,
   * rulesRepo.listActive) match against. If omitted, the facade falls
   * back to derived values, which can be lossy for memory/hint scope
   * variants (interlocutor / conversation / role / channel).
   */
  native?: KnowledgeProposalNativeFields;
}

export interface KnowledgeProposeResult {
  proposal_id: string;
  initial_status: KnowledgeLifecycleStatus;
  visible_to_llm: boolean;
  reason: string;
}

export interface KnowledgeTransitionInput {
  kind: KnowledgeKind;
  proposal_id: string;
  to: KnowledgeLifecycleStatus;
  reason: string;
  decided_by: KnowledgeDecidedBy;
  evidence_id?: string;
}

export interface KnowledgeTransitionRecord {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  at: string; // ISO timestamp
  reason: string;
  decided_by: KnowledgeDecidedBy;
  risk_score?: {
    level: KnowledgeRiskLevel;
    sensitivity?: KnowledgeSensitivity;
    reasons?: string[];
    source?: string;
  };
  evidence_id?: string;
}

export type KnowledgeTransitionResult = KnowledgeTransitionRecord;

export interface KnowledgeRevokeInput {
  kind: KnowledgeKind;
  proposal_id: string;
  reason: string;
  decided_by:
    | 'human_rejection'
    | 'incident_response'
    | 'drift_decision'
    | 'contraevidence';
  /**
   * Optional cancellation signal. When provided, an abort during the
   * bounded retry loop's backoff sleep clears the timer and rejects with
   * an AbortError instead of waiting the backoff out. Pre-checked on
   * entry so an already-aborted caller never issues a DB write. Issue
   * #256 (PR #279 Codex review — Blocker [2]).
   */
  signal?: AbortSignal;
}

export type KnowledgeRevokeResult = KnowledgeTransitionRecord;

export interface KnowledgeRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  lifecycle_status: KnowledgeLifecycleStatus;
  lifecycle_transitions: KnowledgeTransitionRecord[];
  evidence_count: number;
  confidence?: number;
  updated_at: Date;
  last_recall_at?: Date | null;
}

export interface KnowledgeVisibilityContext {
  context_mode?: 'normal' | 'strict' | 'debug';
}

export interface KnowledgeVisibilityResult {
  visible: boolean;
  weight: number;
  label: string | null;
}
