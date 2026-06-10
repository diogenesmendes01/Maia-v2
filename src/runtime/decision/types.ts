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
import type { AudienceType, DataScope, TrustLevel } from '@/shared/audience.js';

export type { ActionMode, ContextRequirements, PepKind, PolicyDecision, RiskLevel };

/**
 * Resolved policy as returned by PolicyDescriptorResolver (P8e).
 *
 * P8e (#93) has merged: the full ResolvedPolicy type lives in
 * `src/control-plane/policy/types.ts` and is mapped onto this narrow port
 * shape by the PolicyDescriptorResolverAdapter in `prod-env.ts`. Collapsing
 * the two types is now unblocked if the indirection ever becomes unwanted.
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
 * P9d (#98) Policy DSL Evaluator has merged: the full rule-body type lives in
 * `src/governance/policy-dsl/types.ts`. PEPs keep this minimal subset as the
 * port shape; unifying with the P9d type is now unblocked.
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
 * P9d (#98) has merged: its PolicyDecision outcome is translated into this
 * verdict shape by the PolicyDSLEvaluatorAdapter in `prod-env.ts`. Unifying
 * the two shapes is now unblocked.
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
 * Policy evaluator interface (DI port).
 *
 * P9d (#98) shipped the concrete evaluator as a pure function
 * (`src/governance/policy-dsl/evaluator.ts`), bridged onto this interface by
 * the PolicyDSLEvaluatorAdapter in `prod-env.ts`. The P9b-era
 * `AllowAllPolicyEvaluator` / `FixturePolicyEvaluator` remain for tests only.
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
 * P8e (#93) has merged: the concrete repo is
 * `src/control-plane/policy/policy-rules-repo.ts`, bridged onto this port by
 * the PolicyRulesRepoAdapter in `prod-env.ts` (getBodySync stays null there —
 * P8e has no sync path, and PEPs fall back to async getBody).
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
 * Skill type (Decision Engine port shape).
 *
 * P9a (#99) Skill Abstraction has merged: the canonical SkillRow lives in the
 * skill registry (`src/control-plane/skill-registry/`), and the
 * SkillsRepoAdapter in `prod-env.ts` maps SkillRow → this shape. Unifying the
 * two types is now unblocked.
 */
export interface Skill {
  id: string;
  /**
   * F1 Phase 1 (Codex HIGH/P2 — immutable identity): the stable Skill Contract
   * descriptor (`skills.skill_descriptor`) + its version. `id`/`version` change
   * across an activate/rollback; the descriptor is the stable handle `runSkill`
   * resolves by. ActionDecider threads both onto `DecisionPacket.routing` so the
   * execute_skill call site can re-resolve and assert the active row is still
   * the exact one the engine evaluated. Optional for legacy/stub skills.
   */
  skill_descriptor?: string;
  version?: number;
  category: 'respond' | 'tool_mediated' | 'decide' | 'plan' | string;
  /**
   * F1 Phase 1: the skill's execution mode (`skills.execution_mode`), distinct
   * from `category` (master spec: they are independent — a `decide`-category
   * skill can be `tool_mediated`). Phase 1 gates execute_skill on
   * `execution_mode ∈ {prompt_only, evaluator}` (terminal, no side effects);
   * `tool_mediated`/`procedure_adapter` are excluded (Phase 2). Optional for
   * legacy/stub skills, in which case the skill is never directly executed.
   */
  execution_mode?: 'prompt_only' | 'evaluator' | 'tool_mediated' | 'procedure_adapter' | string;
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
  /**
   * Issue #415 — role → skill axis (`applicable_to_role`, capability-taxonomy.md
   * §5). The role keys for which this skill is in scope, carried through from
   * `skills.applicable_to_role`. EMPTY/absent = applies regardless of active
   * role (baseline behaviour). When non-empty, the SkillSelector keeps this
   * candidate ONLY when the turn's active role is one of these keys
   * (`selector(intent) ∩ applicable_to_role`, taxonomy §2 step 5) — a scoping
   * filter that can only REMOVE a candidate, never authorize one.
   */
  applicable_to_role?: string[];
  allowed_tools?: string[];
  blocked_tools?: string[];
  requires_confirmation_tools?: string[];
  runtime_hints?: {
    allow_deep_context?: boolean;
  };
  output_schema_ref?: string;
  /**
   * Issue #409 — the native SkillUsagePolicy JSONB (audience/channel/data_scope/
   * exposure/auth/confirmation/risk), carried through from `skills.usage_policy`
   * so the SkillSelector candidate filter can admit/remove this skill against
   * the resolved AudienceContext BEFORE any tool reaches the LLM. Raw record
   * (parsed/validated by `src/skills/usage-policy.ts`); absent/`null` ⇒ the
   * conservative internal-only default.
   */
  usage_policy?: Record<string, unknown> | null;
}

/**
 * Skills repository (Decision Engine port).
 *
 * P9a (#99) has merged: the concrete repo is
 * `src/control-plane/skill-registry/skills-repo.ts`, bridged onto this port
 * by the SkillsRepoAdapter in `prod-env.ts` (which pins lookups to the routed
 * tenant/agent — see adapter 4 notes there).
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
      /**
       * Issue #415 — the turn's ACTIVE role key (from the role-selector). When
       * supplied, the candidate set excludes any skill whose non-empty
       * `applicable_to_role` does not contain this key (taxonomy §2 step 5). The
       * production adapter returns all active scoped skills and lets the
       * SkillSelector apply the role filter; absent ⇒ no role scoping.
       */
      applicable_to_role?: string;
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
 * Channel policy (port shape).
 *
 * Table shape confirmed: `channel_policies` (migration 033) carries
 * `agent_id` directly, which the ChannelPoliciesReaderAdapter in
 * `prod-env.ts` (#157) returns as `default_agent_id`. No alignment work left.
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
 * P3b shipped `procedureExecutionsRepo` with a typed `findById`; the
 * ProceduresRepoAdapter in `prod-env.ts` maps that row onto this narrow
 * shape. Replacing this port type with the concrete row is now unblocked.
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
 * Production wiring exists: the HaikuClientAdapter in `prod-env.ts` wraps
 * `lib/claude.ts#callLLM` onto this interface. Spec §7.1 calls
 * `haiku.classify(...)`.
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
 * P8e (#93) has merged: the concrete class lives in
 * `src/control-plane/policy/policy-descriptor-resolver.ts` and reaches the
 * engine via the PolicyDescriptorResolverAdapter in `prod-env.ts`. This port
 * stays by design — per spec Architecture Lock, Decision Engine must NEVER
 * import the resolver directly.
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
  /**
   * Issue #415 — the turn's ACTIVE role key (resolved by the role-selector
   * chain; LLM suggests, policy decides — taxonomy §3). When present, the
   * SkillSelector applies the role → skill scope (`applicable_to_role`): a skill
   * that declares a non-empty `applicable_to_role` is a candidate ONLY when this
   * key is one of them (`selector(intent) ∩ applicable_to_role`, taxonomy §2
   * step 5). Absent ⇒ no role scoping (legacy callers / role-agnostic turns);
   * skills with an empty `applicable_to_role` are always in scope regardless.
   */
  active_role_key?: string;
  /** Round-2 finding 4: abort signal from Decision Engine deadline. */
  signal?: AbortSignal;
  /**
   * Issue #409 — the resolved audience/channel/risk facts the candidate filter
   * evaluates each skill's `usage_policy` against. Optional + nullable so the
   * many existing call sites (and the legacy stub env) keep compiling; when
   * ABSENT the selector applies the conservative usage-policy default to every
   * candidate (fail-closed). The Decision Engine populates this from the
   * BaseContextPacket's audience attribution (#407) + the turn channel + the
   * scored risk level.
   */
  audience?: SkillSelectorAudience | null;
}

/**
 * Issue #409 — narrow projection of the resolved AudienceContext (#407) + the
 * turn channel + scored risk, used by the SkillSelector candidate filter to
 * admit/remove a skill by its `usage_policy`. Mirrors
 * `UsagePolicyEvalContext` in `src/skills/usage-policy.ts` but is declared here
 * to keep the decision module's port interfaces self-contained.
 */
export interface SkillSelectorAudience {
  audience_type: AudienceType;
  trust_level: TrustLevel;
  /** Channel the turn arrived on (e.g. `whatsapp`). */
  channel_type: string;
  /**
   * Data classes the audience may receive this turn (when known). A skill whose
   * declared `data_scope` is not a subset is removed (`data_scope_blocked`).
   */
  allowed_data_scope?: readonly DataScope[];
  /** Scored pre-execution turn risk (RiskScorer), when known. */
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
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
