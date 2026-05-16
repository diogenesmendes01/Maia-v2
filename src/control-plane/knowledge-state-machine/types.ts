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
