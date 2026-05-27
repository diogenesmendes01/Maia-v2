/**
 * P9a — SkillRunner (executor estável de Skill Contracts).
 *
 * Fluxo 7-gate (master spec v3.1.1 §2.4 + §3.4):
 *  Gate 1. Feature flag (FEATURE_SKILL_REGISTRY_V1)
 *  Gate 1.5. Tenant + agent guard (review #99 finding 1) — assertAgentScope.
 *  Gate 2. Lookup skill ativo (skillsRepo.findActive). Tenant + agent-scoped.
 *  Gate 3. Validação do input contra `skill.input_schema`
 *  Gate 4. Resolução de policy_descriptors via PolicyDescriptorResolver (P8e).
 *          FAIL CLOSED: descriptors declarados mas unresolved → BLOCK com
 *          reason `unresolved_policy` (review #99 finding 2).
 *  Gate 4.5. Aplicação de policies pre-execução:
 *            - effect='block' → reason 'policy_blocked'
 *            - rule_kind='hard_limit' AND evaluator matches → reason
 *              'hard_limit_block'
 *  Gate 5/6. Wrapper `runCognitiveModule` (P1 invariant: toda execução audita)
 *           dispatcher por execution_mode. AbortSignal propagado a modes
 *           para cortar tool calls em timeout (review #99 finding 3).
 *  Gate 7. Validação do output contra `skill.output_schema`
 *
 * Master spec §0.4 princípio 3: skill orquestra, não age. O executor é
 * estável (este arquivo + 4 modes); o contrato é declarativo (linha em
 * `skills`).
 */
import { runCognitiveModule } from '@/cognition/runner.js';
import { skillsRepo } from '@/db/repositories.js';
import { policyDescriptorResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName, SkillExecutionMode } from '@/types/enums.js';
import { promptOnlyMode } from './modes/prompt-only.js';
import { procedureAdapterMode } from './modes/procedure-adapter.js';
import { toolMediatedMode } from './modes/tool-mediated.js';
import { evaluatorMode } from './modes/evaluator.js';
import {
  tryGetCurrentContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import type {
  SkillExecutionInput,
  SkillExecutionOutput,
  SkillExecutionTrace,
  ExecutionModeHandler,
  ResolvedPolicyDescriptor,
  SkillTriggeredBy,
} from './types.js';
import type { SkillRow } from '@/db/schema.js';

const MODE_DISPATCH: Record<string, ExecutionModeHandler> = {
  [SkillExecutionMode.PROMPT_ONLY]: promptOnlyMode,
  [SkillExecutionMode.PROCEDURE_ADAPTER]: procedureAdapterMode,
  [SkillExecutionMode.TOOL_MEDIATED]: toolMediatedMode,
  [SkillExecutionMode.EVALUATOR]: evaluatorMode,
};

const DEFAULT_TIMEOUT_MS = 30_000;

const EMPTY_TRACE: SkillExecutionTrace = {
  mode: null,
  skill_version: null,
  skill_id: null,
};

/**
 * Triggered_by values supported by `runCognitiveModule` (cognition/types.ts).
 * SkillRunner accepts a richer set (incl. user_message, tool_loop,
 * evaluator_pipeline); we map them to the cognition-runner accepted vocabulary.
 */
function mapTriggeredBy(t: SkillTriggeredBy): 'sync_required' | 'sync_conditional' | 'async_event' {
  if (t === 'sync_required' || t === 'sync_conditional' || t === 'async_event') return t;
  if (t === 'user_message' || t === 'tool_loop') return 'sync_required';
  // evaluator_pipeline runs as a conditional sync side-effect of capability tests.
  if (t === 'evaluator_pipeline') return 'sync_conditional';
  return 'sync_required';
}

/**
 * Assert that the requested execution stays within the current tenant +
 * agent scope (review #99 finding 1). Throws on violation.
 *
 *  - Tenant must exist in context (no anonymous execution).
 *  - input.agent_id, when provided, must match context agent OR be null
 *    (tenant-wide intent).
 *  - skill.agent_id, when not null, must match context agent.
 *  - tenant-wide skills (skill.agent_id === null) require policy approval
 *    to read data of another agent; the caller path enforces that via the
 *    PolicyDescriptorResolver. We do NOT auto-permit cross-agent reads.
 */
function assertAgentScope(args: {
  input: SkillExecutionInput;
  skill: SkillRow;
}): { ok: true } | { ok: false; reason: string } {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    return { ok: false, reason: 'missing_tenant_context' };
  }
  if (args.input.agent_id !== undefined && args.input.agent_id !== null) {
    if (args.input.agent_id !== ctx.agent_id) {
      return {
        ok: false,
        reason: `input agent_id ${args.input.agent_id} differs from context ${ctx.agent_id}`,
      };
    }
  }
  if (args.skill.tenant_id !== ctx.tenant_id) {
    return {
      ok: false,
      reason: `skill tenant ${args.skill.tenant_id} differs from context ${ctx.tenant_id}`,
    };
  }
  if (args.skill.agent_id !== null && args.skill.agent_id !== ctx.agent_id) {
    return {
      ok: false,
      reason: `skill agent ${args.skill.agent_id} differs from context ${ctx.agent_id}`,
    };
  }
  return { ok: true };
}

export async function runSkill(input: SkillExecutionInput): Promise<SkillExecutionOutput> {
  const startTime = Date.now();

  // Gate 1: feature flag
  if (!featureFlags.isEnabled(FeatureFlagName.SKILL_REGISTRY_V1)) {
    return {
      ok: false,
      reason: 'flag_off',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: EMPTY_TRACE,
    };
  }

  // Gate 1.5: tenant + agent context required (review #99 finding 1).
  // runSkill cannot execute outside runWithTenantContext. We probe early
  // so we return a structured failure instead of letting findActive throw.
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    return {
      ok: false,
      reason: 'agent_scope_violation',
      message: 'missing_tenant_context — runSkill must execute inside runWithTenantContext',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: EMPTY_TRACE,
    };
  }
  // Explicit input.agent_id mismatch is rejected even before lookup.
  if (
    input.agent_id !== undefined &&
    input.agent_id !== null &&
    input.agent_id !== ctx.agent_id
  ) {
    return {
      ok: false,
      reason: 'agent_scope_violation',
      message: `input agent_id ${input.agent_id} differs from context ${ctx.agent_id}`,
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: EMPTY_TRACE,
    };
  }

  // Gate 2: lookup skill ativo (tenant- AND agent-scoped pelo skillsRepo)
  let skill: SkillRow | null;
  try {
    skill = await skillsRepo.findActive(input.skill_descriptor, input.agent_id);
  } catch (err) {
    const e = err as Error;
    // agent_scope_violation surfaces here when input.agent_id targets a
    // different agent than context.
    if (e.message.startsWith('agent_scope_violation')) {
      return {
        ok: false,
        reason: 'agent_scope_violation',
        message: e.message,
        latency_ms: Date.now() - startTime,
        resolved_policies: [],
        trace: EMPTY_TRACE,
      };
    }
    logger.warn({ err: e.message, descriptor: input.skill_descriptor }, 'p9a.runner.lookup_failed');
    return {
      ok: false,
      reason: 'executor_error',
      message: e.message,
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: EMPTY_TRACE,
    };
  }
  if (!skill) {
    return {
      ok: false,
      reason: 'skill_not_found',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: EMPTY_TRACE,
    };
  }

  const skillTrace: SkillExecutionTrace = {
    mode: skill.execution_mode as SkillExecutionMode,
    skill_version: skill.version,
    skill_id: skill.id,
  };

  // Gate 1.6 (Codex #216 review HIGH-B): close the execution TOCTOU. When the
  // caller pinned an expected identity (the Decision Engine validated a specific
  // active row before routing here), the row we just re-resolved by descriptor
  // MUST still match it. An activate/rollback in the window between the caller's
  // pre-check and this lookup would otherwise execute a DIVERGENT active row.
  // Fail-closed on mismatch so the caller degrades safely instead of running it.
  if (
    (input.expected_skill_id !== undefined && skill.id !== input.expected_skill_id) ||
    (input.expected_skill_version !== undefined &&
      skill.version !== input.expected_skill_version)
  ) {
    logger.warn(
      {
        descriptor: input.skill_descriptor,
        expected_id: input.expected_skill_id,
        expected_version: input.expected_skill_version,
        resolved_id: skill.id,
        resolved_version: skill.version,
      },
      'p9a.runner.identity_mismatch',
    );
    return {
      ok: false,
      reason: 'identity_mismatch',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: skillTrace,
    };
  }

  // Gate 1.5b: re-assert agent scope on the resolved skill (defense in
  // depth — findActive should have prevented cross-agent skills surfacing,
  // but tests / future repo refactors could leak).
  const scopeCheck = assertAgentScope({ input, skill });
  if (!scopeCheck.ok) {
    return {
      ok: false,
      reason: 'agent_scope_violation',
      message: scopeCheck.reason,
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: skillTrace,
    };
  }

  // Gate 3: input validation
  const inputValidation = validateAgainstSchema(input.input, skill.input_schema as Record<string, unknown>);
  if (!inputValidation.valid) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: inputValidation.errors.join('; '),
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: skillTrace,
    };
  }

  // Gate 4: resolve policy descriptors via P8e PolicyDescriptorResolver.
  // The P8e resolver returns a typed shape (`PolicyDescriptorResolverOutput`)
  // with `resolved: ResolvedPolicy[]` (no effect/evaluator — those are part
  // of P9d's DSL evaluator) and `unresolved: string[]` + `failures` (typed
  // reasons). We bridge to the local `ResolvedPolicyDescriptor` shape used
  // by applyPoliciesPreSkill. Until P9d, descriptors that resolve get
  // `effect: 'noop'` by default — applyPoliciesPreSkill won't BLOCK on
  // bare hard_limit without an evaluator.
  const tenantId = getCurrentTenant();
  const currentAgentId = getCurrentAgent();
  const descriptors = (skill.policy_descriptors ?? []) as string[];
  const p8eOutputRaw = await policyDescriptorResolver.resolveDescriptors({
    tenant_id: tenantId,
    agent_id: currentAgentId,
    descriptors,
    scope: { skill_category: skill.category },
  });
  // Defensive cast: tests mock the resolver and may include legacy fields
  // (effect, evaluator, reason) on resolved entries. We accept those as
  // pass-through so existing P9a unit tests keep covering the post-Gate-4
  // flow until P9d delivers the real effect-resolution.
  const p8eOutput = p8eOutputRaw as unknown as {
    resolved: Array<Partial<ResolvedPolicyDescriptor> & {
      policy_id: string;
      descriptor: string;
      rule_kind?: string;
    }>;
    unresolved: Array<string | { descriptor: string; reason?: string }>;
    failures?: Array<{ descriptor: string; reason: string }>;
  };
  const resolvedPolicies: ResolvedPolicyDescriptor[] = p8eOutput.resolved.map((p) => ({
    policy_id: p.policy_id,
    descriptor: p.descriptor,
    effect: p.effect ?? 'noop',
    reason: p.reason,
    rule_kind: p.rule_kind === 'hard_limit' ? 'hard_limit' : p.rule_kind === 'soft' ? 'soft' : undefined,
    evaluator: p.evaluator,
  }));
  const resolvedPolicyIds = resolvedPolicies.map((p) => p.policy_id);

  // Fail-closed: if the skill declares policy_descriptors and any descriptor
  // is unresolved, BLOCK execution (review #99 finding 2). This prevents
  // the resolver stub / future bugs from silently degrading enforcement.
  if (descriptors.length > 0 && p8eOutput.unresolved.length > 0) {
    const unresolvedNames = p8eOutput.unresolved
      .map((u) => (typeof u === 'string' ? u : u.descriptor))
      .join(', ');
    return {
      ok: false,
      reason: 'unresolved_policy',
      message: `unresolved descriptors: ${unresolvedNames}`,
      latency_ms: Date.now() - startTime,
      resolved_policies: resolvedPolicyIds,
      trace: skillTrace,
    };
  }

  // Gate 4.5: apply policies pre-skill (early block).
  const policyDecision = applyPoliciesPreSkill(resolvedPolicies, {
    skill,
    input: input.input,
  });
  if (policyDecision.decision === 'block') {
    return {
      ok: false,
      reason: policyDecision.kind === 'hard_limit' ? 'hard_limit_block' : 'policy_blocked',
      message: policyDecision.reason,
      latency_ms: Date.now() - startTime,
      resolved_policies: resolvedPolicyIds,
      trace: skillTrace,
    };
  }

  // Gate 6: wrap em runCognitiveModule (P1 invariant — audit obrigatório).
  // AbortSignal: propagated from caller OR created locally so we can
  // signal cancellation when the runner timeout fires. Modes are required
  // to forward this to callLLM / toolDispatcher.
  const hints = (skill.runtime_hints ?? {}) as Record<string, unknown>;
  const timeoutMs = typeof hints.timeout_ms === 'number' ? hints.timeout_ms : DEFAULT_TIMEOUT_MS;

  const abortController = new AbortController();
  if (input.signal) {
    // Forward caller cancellation to our internal controller.
    if (input.signal.aborted) abortController.abort();
    else input.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const fallbackOutput: SkillExecutionOutput = {
    ok: false,
    reason: 'executor_error',
    latency_ms: 0,
    resolved_policies: resolvedPolicyIds,
    trace: skillTrace,
  };

  const moduleResult = await runCognitiveModule<SkillExecutionOutput>(
    {
      name: `skill:${skill.skill_descriptor}`,
      version: `v${skill.version}`,
      triggered_by: mapTriggeredBy(input.triggered_by),
      timeoutMs,
      conversa_id: input.conversa_id,
      turno_id: input.turno_id,
      fallback: () => {
        // Timeout firing here means runCognitiveModule rejected the racing
        // promise — signal the in-flight mode so it stops dispatching tools
        // (review #99 finding 3).
        abortController.abort();
        return {
          ...fallbackOutput,
          latency_ms: Date.now() - startTime,
        };
      },
    },
    async () => {
      const modeHandler = MODE_DISPATCH[skill!.execution_mode];
      if (!modeHandler) {
        throw new Error(`unknown_execution_mode: ${skill!.execution_mode}`);
      }
      const modeOutput = await modeHandler({
        skill: skill!,
        input: input.input,
        resolvedPolicies,
        conversa_id: input.conversa_id,
        turno_id: input.turno_id,
        signal: abortController.signal,
      });

      // Gate 7: output validation
      const outputValidation = validateAgainstSchema(
        modeOutput,
        skill!.output_schema as Record<string, unknown>,
      );
      if (!outputValidation.valid) {
        return {
          ok: false,
          reason: 'invalid_output' as const,
          message: outputValidation.errors.join('; '),
          latency_ms: Date.now() - startTime,
          resolved_policies: resolvedPolicyIds,
          trace: skillTrace,
        };
      }

      return {
        ok: true,
        output: modeOutput,
        latency_ms: Date.now() - startTime,
        resolved_policies: resolvedPolicyIds,
        trace: skillTrace,
      };
    },
  );

  if (moduleResult.status === 'timeout') {
    abortController.abort();
    return {
      ok: false,
      reason: 'timeout',
      message: 'execution exceeded timeout_ms',
      latency_ms: moduleResult.latency_ms,
      resolved_policies: resolvedPolicyIds,
      trace: skillTrace,
    };
  }

  return (
    moduleResult.output ?? {
      ok: false,
      reason: 'executor_error',
      latency_ms: moduleResult.latency_ms,
      resolved_policies: resolvedPolicyIds,
      trace: skillTrace,
    }
  );
}

/**
 * Aplica decisões de policy pré-execução. Em P9a:
 *  - `effect='block'` → decisão 'block' com kind='policy' (mapeia para
 *    reason `policy_blocked` no SkillRunner).
 *  - `rule_kind='hard_limit'` AND evaluator(matched=true) → decisão 'block'
 *    com kind='hard_limit' (mapeia para reason `hard_limit_block`).
 *
 * P9a inicial não tinha o conceito hard_limit; foi adicionado no Codex
 * review #99 finding 2 para evitar que regras críticas (e.g. PII out-of-
 * region, budget overrun) só sejam aplicadas via warning.
 */
export function applyPoliciesPreSkill(
  policies: ResolvedPolicyDescriptor[],
  ctx?: { skill: SkillRow; input: Record<string, unknown> },
): { decision: 'allow' } | { decision: 'block'; reason?: string; kind: 'policy' | 'hard_limit' } {
  for (const p of policies) {
    // hard_limit rules: evaluator decides; matched=true → BLOCK.
    if (p.rule_kind === 'hard_limit' && typeof p.evaluator === 'function' && ctx) {
      let evalRes: { matched: boolean; reason?: string };
      try {
        evalRes = p.evaluator({ skill: ctx.skill, input: ctx.input });
      } catch (err) {
        // Evaluator throw is treated as match (fail-closed for hard limits).
        return {
          decision: 'block',
          reason: `hard_limit_evaluator_error: ${(err as Error).message}`,
          kind: 'hard_limit',
        };
      }
      if (evalRes.matched) {
        return {
          decision: 'block',
          reason: evalRes.reason ?? `hard_limit_matched_${p.descriptor}`,
          kind: 'hard_limit',
        };
      }
      // No match: continue to next policy.
      continue;
    }
    // Soft block via effect.
    if (p.effect === 'block') {
      return {
        decision: 'block',
        reason: p.reason ?? `blocked_by_${p.descriptor}`,
        kind: 'policy',
      };
    }
  }
  return { decision: 'allow' };
}

/**
 * Schema validator minimalista. Em produção será substituído por Ajv (TODO).
 * Suporta apenas `{ type: 'object', required: [...], properties: { ... } }`
 * — suficiente para gates de input/output em P9a. Schemas inválidos /
 * ausentes são tratados como "permissivos" (valid=true) para não quebrar
 * skills sem schema definido em fases iniciais.
 */
export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown> | null | undefined,
): { valid: boolean; errors: string[] } {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`expected object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
      return { valid: false, errors };
    }
    const obj = data as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`missing required field: ${key}`);
      }
    }
    const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj && obj[key] !== undefined && propSchema && propSchema.type) {
        const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
        const expectedType = propSchema.type;
        if (expectedType === 'string' && actualType !== 'string') {
          errors.push(`field ${key} expected string, got ${actualType}`);
        } else if (expectedType === 'number' && actualType !== 'number') {
          errors.push(`field ${key} expected number, got ${actualType}`);
        } else if (expectedType === 'boolean' && actualType !== 'boolean') {
          errors.push(`field ${key} expected boolean, got ${actualType}`);
        } else if (expectedType === 'object' && (actualType !== 'object' || obj[key] === null)) {
          errors.push(`field ${key} expected object, got ${actualType}`);
        } else if (expectedType === 'array' && actualType !== 'array') {
          errors.push(`field ${key} expected array, got ${actualType}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export type { SkillExecutionInput, SkillExecutionOutput };
