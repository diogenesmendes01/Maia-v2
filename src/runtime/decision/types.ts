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
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel a slow
 * evaluator when the hot-path budget fires.
 */
export interface PolicyEvaluator {
  evaluate(
    body: PolicyRuleBody,
    context: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<PolicyEvaluatorVerdict>;
}

/**
 * Repository for fetching policy rule bodies by ID.
 *
 * TODO(P8e #93): Replace with PolicyRulesRepo from P8e.
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel a slow repo
 * lookup when the hot-path budget fires.
 */
export interface PolicyRulesRepo {
  getBody(
    policy_id: string,
    options?: { signal?: AbortSignal },
  ): Promise<PolicyRuleBody | null>;
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
  /**
   * F1 Phase 0: free-text "when to use this skill" guidance from the Skill
   * Contract (`skills.when_to_use`). SkillSelector matches the classified
   * intent against this text (plus `applicable_to_intent`) so a skill is only
   * selected when the turn clearly relates to it — the anti-hijack guard. May
   * be absent for legacy/stub skills, in which case matching falls back to
   * `applicable_to_intent` / the descriptor.
   */
  when_to_use?: string;
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
 *
 * Codex round-2 finding 3: `find` MUST be scoped by tenant_id + agent_id.
 * The legacy unscoped `find(skill_id)` would silently return a skill from a
 * different agent (or even a different tenant in pathological data shapes),
 * which then leaks its `allowed_tools` into the DecisionPacket. The scoped
 * overload is now the only signature on the port; callers either pass scope
 * or use the cached `Skill` object resolved upstream by `SkillSelector`.
 *
 * Round-2 finding 4: optional `signal` lets callers cancel slow I/O when
 * the Decision Engine deadline fires.
 */
export interface SkillsRepo {
  findActive(
    query: {
      tenant_id: string;
      agent_id: string;
      applicable_to_intent?: string;
      applicable_to_workflow?: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<Skill[]>;
  /**
   * Scoped lookup. Implementations MUST verify that the returned skill
   * belongs to the supplied tenant_id+agent_id and return `null` otherwise.
   */
  find(
    skill_id: string,
    scope: { tenant_id: string; agent_id: string },
    options?: { signal?: AbortSignal },
  ): Promise<Skill | null>;
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
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel a slow
 * lockdown lookup when the hot-path budget fires.
 */
export interface LockdownReader {
  isChannelLockedDown(
    channel_id: string,
    tenant_id: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
  isTenantInGlobalLockdown(
    tenant_id: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
  /**
   * Returns true if tenant has data that makes a budget-fallback
   * `ask_clarification` unsafe (must escalate instead). Spec §6.2.
   */
  tenantHasSensitiveContext(
    tenant_id: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
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
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel slow content
 * resolution (e.g. blob store) when the hot-path budget fires.
 */
export interface ContentResolver {
  text(content_ref: string, options?: { signal?: AbortSignal }): Promise<string>;
}

/**
 * Haiku LLM client (intent classifier fallback).
 *
 * TODO: Replace with concrete HaikuClient from lib/claude.ts once a stable
 * narrow interface is exposed. Spec §7.1 calls `haiku.classify(...)`.
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel a slow Haiku
 * call when the hot-path budget fires. The Anthropic SDK accepts an
 * AbortSignal natively.
 */
export interface HaikuClient {
  classify(
    params: {
      text: string;
      allowed_labels: string[];
      max_tokens: number;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ label: string; confidence: number; top3?: string[] }>;
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
 *
 * Round-2 finding 4: `signal` lets the Decision Engine cancel a slow
 * resolver call when the hot-path budget fires.
 */
export interface PolicyDescriptorResolver {
  resolveDescriptors(
    query: ResolveDescriptorsQuery,
    options?: { signal?: AbortSignal },
  ): Promise<ResolvedPolicy[]>;
}

// ============================================================================
// Early PEP
// ============================================================================

export interface EarlyPepInput {
  base: BaseContextPacket;
  resolved_policies: ResolvedPolicy[];
  /** Round-2 finding 4: abort signal from Decision Engine deadline. */
  signal?: AbortSignal;
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
  /**
   * Structured tool-set reductions issued by `reduce_tool_set` policies.
   *
   * Spec §4.2 + Codex review #103: a Mid PEP `reduce_tool_set` MUST become
   * an enforceable rule (not only a warning). Each entry instructs the
   * action-decider to subtract the listed tools from the final
   * `allowed_tools` and move them into `blocked_tools` with audit trail.
   *
   * Empty (or undefined) on Early PEP since it has no skill/tool context.
   */
  tool_reductions?: Array<{
    policy_id: string;
    rule_descriptor: string;
    removed_tools: string[];
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
  /**
   * Preview of the tool permissions that will reach the final packet IF no
   * Mid-PEP verdict mutates them. Codex round-2 finding 2: the Decision
   * Engine MUST populate this from the resolved Skill object, NOT pass an
   * empty placeholder. Otherwise tool-based block/reduce predicates evaluate
   * against `[]` and approve tools that later appear in the packet.
   */
  tool_permissions_preview: DecisionPacket['tool_permissions'];
  /**
   * The scoped Skill object selected by SkillSelector, when one was found.
   * Allows policy evaluators to inspect schema refs / runtime hints without
   * an extra repo lookup, and guarantees Mid PEP sees the same skill
   * instance that ActionDecider will use downstream.
   */
  selected_skill?: Skill;
  resolved_policies: ResolvedPolicy[];
  /** Round-2 finding 4: abort signal from Decision Engine deadline. */
  signal?: AbortSignal;
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
  classify(
    base: BaseContextPacket,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['intent']>;
}

export interface RiskScorer {
  score(
    input: {
      intent: DecisionPacket['intent'];
      base: BaseContextPacket;
    },
    options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['risk_profile']>;
}

export interface WorkflowSelectorResult {
  workflow_id?: string;
  mode: 'continue' | 'switch' | 'none';
}

export interface WorkflowSelector {
  select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowSelectorResult>;
}

export interface AgentSelector {
  select(
    base: BaseContextPacket,
    options?: { signal?: AbortSignal },
  ): Promise<{ agent_id: string }>;
}

export interface SkillSelectorResult {
  selected_skill_id?: string;
  candidate_skill_ids: string[];
  /**
   * Codex round-2 findings 2+3: when a skill is selected we carry the
   * resolved Skill object forward so Mid PEP and ActionDecider can see the
   * same scoped instance (with its `allowed_tools` / `blocked_tools` /
   * `requires_confirmation_tools`). Without this, Mid PEP would evaluate
   * tool-based predicates against an empty preview and ActionDecider would
   * re-fetch by ID under no scope, both of which produce divergent or
   * cross-agent results.
   */
  selected_skill?: Skill;
}

export interface SkillSelectorOptions {
  /**
   * Optional override for the agent under which skills are looked up. When
   * the channel policy resolves a different default agent than the base
   * packet, the engine MUST pass this so that skill candidates and tool
   * permissions belong to the routed agent (Codex review #103).
   */
  agent_id_override?: string;
  workflow_id?: string;
  /** Round-2 finding 4: abort signal from Decision Engine deadline. */
  signal?: AbortSignal;
}

export interface SkillSelector {
  select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
    options?: SkillSelectorOptions,
  ): Promise<SkillSelectorResult>;
}

export interface ActionDeciderInput {
  base: BaseContextPacket;
  intent: DecisionPacket['intent'];
  risk: DecisionPacket['risk_profile'];
  workflow: WorkflowSelectorResult;
  /**
   * Round-2 finding 3: `skill.selected_skill` (when present) carries the
   * SAME resolved Skill object that SkillSelector queried under the routed
   * agent. ActionDecider MUST prefer this over an unscoped `find()` lookup,
   * otherwise it can emit `tool_permissions` from a homonym skill belonging
   * to a different agent or tenant.
   */
  skill: SkillSelectorResult;
  midPepOutcome: MidPepOutput;
  earlyWarnings: ContinueDecision['warnings'];
  /** Round-2 finding 4: abort signal from Decision Engine deadline. */
  signal?: AbortSignal;
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
  | 'resolver'
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
