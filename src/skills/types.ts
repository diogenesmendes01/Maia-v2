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
   * Optional: scope a lookup to a specific agent. `null` = tenant-wide skill;
   * `undefined` = qualquer (default — pega tenant-wide ou agent-scoped match).
   */
  agent_id?: string | null;
}

export type SkillFailureReason =
  | 'flag_off'
  | 'skill_not_found'
  | 'policy_blocked'
  | 'budget_exceeded'
  | 'invalid_input'
  | 'invalid_output'
  | 'executor_error'
  | 'timeout';

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
}

export interface UnresolvedPolicyDescriptor {
  descriptor: string;
  reason: string;
}

export interface PolicyResolutionResult {
  resolved: ResolvedPolicyDescriptor[];
  unresolved: UnresolvedPolicyDescriptor[];
}
