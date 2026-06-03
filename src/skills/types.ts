/**
 * P9a — Skill runtime types (executor + slice builder).
 *
 * Definidos aqui para evitar acoplamento entre `src/control-plane/`
 * (Source of Truth offline) e `src/skills/` (runtime executor).
 *
 * Master spec v3.1.1 §6 (SkillSlice) + §3.4 (Agent Runtime + runtime_hints).
 */
import type { SkillRow, SkillRuntimeHints } from '@/db/schema.js';
import type { SkillExecutionMode } from '@/types/enums.js';
import type { AudienceType, DataScope, TrustLevel } from '@/shared/audience.js';

/**
 * Triggered_by alinha com o vocabulário de `RunModuleOptions.triggered_by`
 * em `src/cognition/types.ts` para que o `runCognitiveModule` aceite o
 * mesmo valor sem cast. `evaluator_pipeline` é P9a-novo (skill chamada
 * por outra skill em modo evaluator).
 */
export type SkillTriggeredBy =
  | 'sync_required'
  | 'sync_conditional'
  | 'async_event'
  | 'evaluator_pipeline'
  | 'user_message'
  | 'tool_loop';

export interface SkillExecutionInput {
  skill_descriptor: string;
  input: Record<string, unknown>;
  conversa_id?: string;
  turno_id?: string;
  triggered_by: SkillTriggeredBy;
  /**
   * Optional: scope a lookup to a specific agent. `null` = tenant-wide skill
   * (must also be allowed by policy when reading another agent's data);
   * `undefined` = default — uses the agent_id from the current tenant context.
   *
   * Cross-agent execution: only allowed when `skill.agent_id === null`
   * (tenant-wide) AND policy permits. Mismatched explicit agent_id is rejected.
   */
  agent_id?: string | null;
  /**
   * Optional AbortSignal that aborts in-flight LLM/tool calls if the caller
   * cancels (e.g. on runner timeout). Modes propagate this signal to
   * `callLLM` and `toolDispatcher` so side-effecting work can be cut off
   * cleanly instead of running to completion behind a non-cancelling
   * Promise.race (review #99 finding 3).
   */
  signal?: AbortSignal;
  /**
   * Optional immutable-identity pin (F1 Phase 1, Codex #216 review HIGH-B).
   * When set, the runner asserts the resolved active skill still matches AFTER
   * its own lookup — closing the TOCTOU between a caller's pre-check and this
   * lookup (an activate/rollback in the window would otherwise execute a
   * divergent active row). Mismatch ⇒ fail-closed with reason
   * 'identity_mismatch'. Absent ⇒ no assertion (legacy callers unaffected).
   */
  expected_skill_id?: string;
  expected_skill_version?: number;
  /**
   * Issue #409 — the resolved audience/channel/data_scope/risk this turn is
   * served to. When set, the runner's gate ~4.6 RE-EVALUATES the skill's
   * `usage_policy` against it (fail-closed), closing the TOCTOU between
   * candidate selection and execution. Absent ⇒ gate 4.6 is skipped (legacy
   * callers / non-audience contexts); the early candidate filter remains the
   * primary enforcement and this gate is the defense-in-depth re-check.
   */
  audience?: SkillRunnerAudience;
}

/**
 * Issue #409 — narrow projection of the resolved AudienceContext (#407) + the
 * turn channel + data-scope + risk, fed to the SkillRunner gate 4.6 to
 * re-evaluate a skill's `usage_policy`. Structurally identical to
 * `UsagePolicyEvalContext` in `src/skills/usage-policy.ts`.
 */
export interface SkillRunnerAudience {
  audience_type: AudienceType;
  trust_level: TrustLevel;
  channel_type: string;
  allowed_data_scope?: readonly DataScope[];
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
}

export type SkillFailureReason =
  | 'flag_off'
  | 'skill_not_found'
  | 'policy_blocked'
  | 'unresolved_policy'
  | 'hard_limit_block'
  | 'agent_scope_violation'
  | 'budget_exceeded'
  | 'invalid_input'
  | 'invalid_output'
  | 'executor_error'
  | 'identity_mismatch'
  | 'timeout'
  // Issue #409 — SkillUsagePolicy execution gate (skill-runner gate ~4.6).
  // Fail-closed reasons emitted when the LATE re-evaluation of the skill's
  // usage policy against the resolved audience refuses execution (closing the
  // TOCTOU window between selection and execution). 1:1 with the
  // `skill_blocked_by_*` AUDIT_ACTIONS.
  | 'audience_blocked'
  | 'channel_blocked'
  | 'data_scope_blocked'
  | 'auth_level_insufficient'
  | 'risk_blocked';

export interface SkillExecutionTrace {
  mode: SkillExecutionMode | null;
  skill_version: number | null;
  skill_id: string | null;
  tools_called?: string[];
  tokens_in?: number;
  tokens_out?: number;
}

export interface SkillExecutionOutput {
  ok: boolean;
  output?: Record<string, unknown>;
  reason?: SkillFailureReason;
  message?: string;
  latency_ms: number;
  resolved_policies: string[];
  trace: SkillExecutionTrace;
}

export interface ModeContext {
  skill: SkillRow;
  input: Record<string, unknown>;
  resolvedPolicies: ResolvedPolicyDescriptor[];
  conversa_id?: string;
  turno_id?: string;
  /**
   * AbortSignal propagated from the runner. Modes are expected to forward
   * this to LLM / tool dispatcher calls so timeout cancellation actually
   * cuts off in-flight side-effecting work.
   */
  signal?: AbortSignal;
}

export type ExecutionModeHandler = (ctx: ModeContext) => Promise<Record<string, unknown>>;

/**
 * P8a Context Packet — SkillSlice (subset usado em P9a). Master spec §6.
 * Definido localmente para não bloquear em P8a; pode ser substituído por
 * import direto quando P8a merge.
 */
export interface SkillSummary {
  id: string;
  skill_descriptor: string;
  category: string;
  execution_mode: SkillExecutionMode;
  goal: string;
  when_to_use: string;
  version: number;
  runtime_hints: SkillRuntimeHints;
}

export interface SkillSlice {
  selected?: SkillSummary;
  candidates: SkillSummary[];
  total_active_in_tenant: number;
  builder_metadata: {
    cache_hit: boolean;
    cached_at?: string;
    ttl_seconds: number;
  };
}

/**
 * Stub do P8e PolicyDescriptorResolver. Forma do retorno casa com a
 * shape esperada pelo SkillRunner; quando P8e merge, este import será
 * trocado por `@/control-plane/policy/policy-descriptor-resolver.js`.
 */
export interface ResolvedPolicyDescriptor {
  policy_id: string;
  descriptor: string;
  effect: 'allow' | 'block' | 'audit' | 'noop';
  reason?: string;
  /**
   * Rule classification (P8e). 'hard_limit' rules combine with an
   * `evaluator` callable to determine match-time block; SkillRunner gate 4.5
   * BLOCKS execution with reason `hard_limit_block` when matched. Soft rules
   * fall back to the `effect` field semantics.
   */
  rule_kind?: 'soft' | 'hard_limit';
  /**
   * Optional matcher invoked by the SkillRunner when `rule_kind='hard_limit'`.
   * `matched: true` → BLOCK execution. Stays optional so P9a/P8e can keep
   * shape-only stubs while the real PolicyDescriptorResolver lands.
   */
  evaluator?: (args: {
    skill: SkillRow;
    input: Record<string, unknown>;
  }) => { matched: boolean; reason?: string };
}

export interface UnresolvedPolicyDescriptor {
  descriptor: string;
  reason: string;
}

export interface PolicyResolutionResult {
  resolved: ResolvedPolicyDescriptor[];
  unresolved: UnresolvedPolicyDescriptor[];
}
