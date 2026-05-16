/**
 * P9b — Decision Engine types.
 *
 * See spec §0.3 (glossário PEP) + §4 (PEPs detalhados).
 */
import type {
  ActionMode,
  BaseContextPacket,
  ContextRequirements,
  DecisionPacket,
  PolicyDecision,
  PepKind,
  RiskLevel,
} from '../context-packet/types.js';

export type { ActionMode, ContextRequirements, PepKind, PolicyDecision, RiskLevel };

/**
 * Resolved policy as returned by PolicyDescriptorResolver (P8e).
 *
 * TODO(P8e #93): Replace with full ResolvedPolicy type once P8e merges.
 */
export interface ResolvedPolicy {
  policy_id: string;
  descriptor: string;
  /**
   * Which PEPs this policy applies to. Default if unspecified is
   * `['mid', 'late']` (master §2.1.1: regra precisa opt-in para 'early').
   */
  applies_to_peps?: PepKind[];
}

/**
 * Policy rule body — minimal subset of fields read by PEPs in P9b.
 *
 * TODO(P9d #98): Replace with full PolicyRuleBody type once P9d Policy DSL
 * Evaluator merges.
 */
export interface PolicyRuleBody {
  policy_id: string;
  descriptor: string;
  applies_to_peps?: PepKind[];
  rule_kind?: 'allow' | 'deny' | 'dual_approval' | 'warn' | string;
  /** Free-form predicate body — evaluated by PolicyEvaluator (P9d). */
  predicate?: unknown;
  /** Parameters used by some rule kinds (e.g. approval_class). */
  parameters?: Record<string, unknown>;
}

/**
 * Verdict returned by PolicyEvaluator when checking a single rule.
 *
 * TODO(P9d #98): Replace with full PolicyEvaluatorVerdict from P9d once merged.
 */
export interface PolicyEvaluatorVerdict {
  action:
    | 'allow'
    | 'block'
    | 'escalate'
    | 'warn_in_trace'
    | 'require_dual_approval'
    | 'reduce_tool_set';
  reason: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  message?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Policy evaluator interface (P9d stub in P9b).
 *
 * TODO(P9d #98): Replace with concrete PolicyEvaluator class from P9d.
 * P9b ships a default `AllowAllPolicyEvaluator` that always returns
 * `allow`, plus a `FixturePolicyEvaluator` for testing.
 */
export interface PolicyEvaluator {
  evaluate(
    body: PolicyRuleBody,
    context: Record<string, unknown>,
  ): Promise<PolicyEvaluatorVerdict>;
}

/**
 * Repository for fetching policy rule bodies by ID.
 *
 * TODO(P8e #93): Replace with PolicyRulesRepo from P8e.
 */
export interface PolicyRulesRepo {
  getBody(policy_id: string): Promise<PolicyRuleBody | null>;
  /** Sync access (cached). Returns null if not in cache. */
  getBodySync(policy_id: string): PolicyRuleBody | null;
}

/**
 * Skill type (P9a stub).
 *
 * TODO(P9a #99): Replace with full Skill type from P9a Skill Abstraction.
 */
export interface Skill {
  id: string;
  category: 'respond' | 'tool_mediated' | 'decide' | 'plan' | string;
  priority: number;
  status: 'active' | 'deprecated' | 'draft';
  applicable_to_intent?: string[];
  applicable_to_workflow?: string[];
  allowed_tools?: string[];
  blocked_tools?: string[];
  requires_confirmation_tools?: string[];
  runtime_hints?: {
    allow_deep_context?: boolean;
  };
  output_schema_ref?: string;
}

/**
 * Skills repository (P9a stub).
 *
 * TODO(P9a #99): Replace with SkillsRepo from P9a.
 */
export interface SkillsRepo {
  findActive(query: {
    tenant_id: string;
    agent_id: string;
    applicable_to_intent?: string;
    applicable_to_workflow?: string;
  }): Promise<Skill[]>;
  find(skill_id: string): Promise<Skill | null>;
}

/**
 * Channel policy (P0 already in prod).
 *
 * TODO(P0 review): align with channel_policies table shape once P0 owners
 * confirm the exact column names. Currently inferred from spec.
 */
export interface ChannelPolicy {
  channel_id: string;
  tenant_id: string;
  default_agent_id: string;
}

export interface ChannelPoliciesReader {
  getForChannel(tenant_id: string, channel_id: string): Promise<ChannelPolicy>;
}

/**
 * Lockdown reader interface used by Early PEP.
 *
 * Bridges to existing `src/governance/lockdown.ts` (P4) via adapter.
 */
export interface LockdownReader {
  isChannelLockedDown(channel_id: string, tenant_id: string): Promise<boolean>;
  isTenantInGlobalLockdown(tenant_id: string): Promise<boolean>;
  /**
   * Returns true if tenant has data that makes a budget-fallback
   * `ask_clarification` unsafe (must escalate instead). Spec §6.2.
   */
  tenantHasSensitiveContext(tenant_id: string): Promise<boolean>;
}

/**
 * Procedure execution data read by workflow-selector.
 *
 * TODO(P3b): replace with concrete row type once procedureExecutionsRepo
 * exposes a typed read method.
 */
export interface ProcedureExecution {
  execution_id: string;
  procedure_id: string;
  procedure_domain: string;
  /** Remaining TTL in ms; spec §7.3 uses 30s threshold. */
  ttl_remaining_ms: number;
}

export interface ProceduresRepo {
  findExecution(execution_id: string): Promise<ProcedureExecution | null>;
}

/**
 * Content resolver — resolves `content_ref` -> message text.
 */
export interface ContentResolver {
  text(content_ref: string): Promise<string>;
}

/**
 * Haiku LLM client (intent classifier fallback).
 *
 * TODO: Replace with concrete HaikuClient from lib/claude.ts once a stable
 * narrow interface is exposed. Spec §7.1 calls `haiku.classify(...)`.
 */
export interface HaikuClient {
  classify(params: {
    text: string;
    allowed_labels: string[];
    max_tokens: number;
  }): Promise<{ label: string; confidence: number; top3?: string[] }>;
}

/**
 * Minimal metrics interface used by Decision Engine.
 *
 * Adapter in `src/lib/metrics.ts` (existing) exposes this shape via a thin
 * wrapper.
 */
export interface MetricsClient {
  increment(name: string, tags?: Record<string, string>): void;
  recordHistogram(name: string, value: number, tags?: Record<string, string>): void;
}

/** Policy descriptor resolver query and result. */
export interface ResolveDescriptorsQuery {
  tenant_id: string;
  agent_id: string;
  descriptors: string[];
  scope: { channel?: string; domain?: string };
}

/**
 * P8e PolicyDescriptorResolver interface (consumed via DI per spec §3.4).
 *
 * TODO(P8e #93): Replace with concrete `PolicyDescriptorResolver` class from
 * `src/control-plane/policy/policy-descriptor-resolver.ts`. Per spec
 * Architecture Lock, Decision Engine must NEVER import the resolver
 * directly.
 */
export interface PolicyDescriptorResolver {
  resolveDescriptors(query: ResolveDescriptorsQuery): Promise<ResolvedPolicy[]>;
}

// ============================================================================
// Early PEP
// ============================================================================

export interface EarlyPepInput {
  base: BaseContextPacket;
  resolved_policies: ResolvedPolicy[];
}

export interface BlockDecision {
  pep: PepKind;
  policy_id: string;
  rule_descriptor: string;
  decision: Extract<PolicyDecision, 'block' | 'escalate'>;
  reason: string;
  user_facing_message?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ContinueDecision {
  pep: PepKind;
  warnings: Array<{
    policy_id: string;
    rule_descriptor: string;
    reason: string;
  }>;
}

export type EarlyPepOutput = BlockDecision | ContinueDecision;

export interface EarlyPep {
  evaluate(input: EarlyPepInput): Promise<EarlyPepOutput>;
}

// ============================================================================
// Mid PEP
// ============================================================================

export interface MidPepInput {
  base: BaseContextPacket;
  intent: DecisionPacket['intent'];
  risk_profile: DecisionPacket['risk_profile'];
  selected_skill_id?: string;
  candidate_skill_ids: string[];
  workflow_id?: string;
  tool_permissions_preview: DecisionPacket['tool_permissions'];
  resolved_policies: ResolvedPolicy[];
}

export interface RequireDualApprovalDecision {
  pep: 'mid';
  policy_id: string;
  rule_descriptor: string;
  decision: 'require_dual_approval';
  reason: string;
  approval_class: 'owner_plus_compliance' | 'owner_plus_technical';
}

export type MidPepOutput = BlockDecision | ContinueDecision | RequireDualApprovalDecision;

export interface MidPep {
  evaluate(input: MidPepInput): Promise<MidPepOutput>;
}

// ============================================================================
// Sub-component interfaces
// ============================================================================

export interface IntentClassifier {
  classify(base: BaseContextPacket): Promise<DecisionPacket['intent']>;
}

export interface RiskScorer {
  score(input: {
    intent: DecisionPacket['intent'];
    base: BaseContextPacket;
  }): Promise<DecisionPacket['risk_profile']>;
}

export interface WorkflowSelectorResult {
  workflow_id?: string;
  mode: 'continue' | 'switch' | 'none';
}

export interface WorkflowSelector {
  select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
  ): Promise<WorkflowSelectorResult>;
}

export interface AgentSelector {
  select(base: BaseContextPacket): Promise<{ agent_id: string }>;
}

export interface SkillSelectorResult {
  selected_skill_id?: string;
  candidate_skill_ids: string[];
}

export interface SkillSelector {
  select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
    workflow_id?: string,
  ): Promise<SkillSelectorResult>;
}

export interface ActionDeciderInput {
  base: BaseContextPacket;
  intent: DecisionPacket['intent'];
  risk: DecisionPacket['risk_profile'];
  workflow: WorkflowSelectorResult;
  skill: SkillSelectorResult;
  midPepOutcome: MidPepOutput;
  earlyWarnings: ContinueDecision['warnings'];
}

export interface ActionDeciderResult {
  action_mode: ActionMode;
  tool_permissions: DecisionPacket['tool_permissions'];
  context_requirements: ContextRequirements;
  evaluation_plan: DecisionPacket['evaluation_plan'];
  rationale: string;
}

export interface ActionDecider {
  decide(input: ActionDeciderInput): Promise<ActionDeciderResult>;
}

// ============================================================================
// Budget tracker
// ============================================================================

export type SubBudgetName =
  | 'early_pep'
  | 'intent'
  | 'risk'
  | 'workflow'
  | 'agent'
  | 'skill'
  | 'mid_pep'
  | 'action';

export interface SubBudget {
  name: SubBudgetName;
  target_ms: number;
}

/** Thrown when overall budget is exhausted; caught by Decision Engine fallback. */
export class BudgetExhaustedError extends Error {
  constructor(
    public step: string,
    public elapsed_ms: number,
  ) {
    super(`Budget exhausted at step=${step} elapsed=${elapsed_ms}ms`);
    this.name = 'BudgetExhaustedError';
  }
}
