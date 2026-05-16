/**
 * P9a — SkillRunner (executor estável de Skill Contracts).
 *
 * Fluxo 7-gate (master spec v3.1.1 §2.4 + §3.4):
 *  Gate 1. Feature flag (FEATURE_SKILL_REGISTRY_V1)
 *  Gate 2. Lookup skill ativo (skillsRepo.findActive)
 *  Gate 3. Validação do input contra `skill.input_schema`
 *  Gate 4. Resolução de policy_descriptors via PolicyDescriptorResolver (P8e/stub)
 *  Gate 4.5. Aplicação de policies pre-execução (allow/block)
 *  Gate 5/6. Wrapper `runCognitiveModule` (P1 invariant: toda execução audita)
 *           dispatcher por execution_mode
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
import { tryGetCurrentContext } from '@/db/tenant-context.js';
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

  // Gate 2: lookup skill ativo (tenant-scoped pelo skillsRepo)
  let skill: SkillRow | null;
  try {
    skill = await skillsRepo.findActive(input.skill_descriptor, input.agent_id);
  } catch (err) {
    const e = err as Error;
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

  // Gate 4: resolve policy descriptors
  const ctx = tryGetCurrentContext();
  const tenantId = ctx?.tenant_id ?? 'default';
  const descriptors = (skill.policy_descriptors ?? []) as string[];
  const policiesResolved = await policyDescriptorResolver.resolveDescriptors({
    tenant_id: tenantId,
    descriptors,
    scope: { skill_category: skill.category },
  });
  const resolvedPolicyIds = policiesResolved.resolved.map((p) => p.policy_id);

  // Gate 4.5: apply policies pre-skill (early block)
  const policyDecision = applyPoliciesPreSkill(policiesResolved.resolved);
  if (policyDecision.decision === 'block') {
    return {
      ok: false,
      reason: 'policy_blocked',
      message: policyDecision.reason,
      latency_ms: Date.now() - startTime,
      resolved_policies: resolvedPolicyIds,
      trace: skillTrace,
    };
  }

  // Gate 6: wrap em runCognitiveModule (P1 invariant — audit obrigatório)
  const hints = (skill.runtime_hints ?? {}) as Record<string, unknown>;
  const timeoutMs = typeof hints.timeout_ms === 'number' ? hints.timeout_ms : DEFAULT_TIMEOUT_MS;

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
      fallback: () => ({
        ...fallbackOutput,
        latency_ms: Date.now() - startTime,
      }),
    },
    async () => {
      const modeHandler = MODE_DISPATCH[skill!.execution_mode];
      if (!modeHandler) {
        throw new Error(`unknown_execution_mode: ${skill!.execution_mode}`);
      }
      const modeOutput = await modeHandler({
        skill: skill!,
        input: input.input,
        resolvedPolicies: policiesResolved.resolved,
        conversa_id: input.conversa_id,
        turno_id: input.turno_id,
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
 * Aplica decisões de policy pré-execução. Em P9a (sem P8e mergeado),
 * apenas verifica se algum policy resolvido tem effect='block'. Quando
 * P8e merge, este método consultará o evaluador real de policy.
 */
export function applyPoliciesPreSkill(
  policies: ResolvedPolicyDescriptor[],
): { decision: 'allow' | 'block'; reason?: string } {
  for (const p of policies) {
    if (p.effect === 'block') {
      return { decision: 'block', reason: p.reason ?? `blocked_by_${p.descriptor}` };
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
