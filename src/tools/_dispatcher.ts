import type { Pessoa, Conversa } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { canAct } from '@/governance/permissions.js';
import { constitutionalCheck } from '@/governance/rules.js';
import { REGISTRY, isToolEnabled, type AnyTool } from './_registry.js';
import { computeIdempotencyKey } from '@/governance/idempotency.js';
import { idempotencyRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { isRedisConnected } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import type { ActionKey } from '@/governance/audit-actions.js';
import { featureFlags } from '@/config/feature-flags.js';

export type ToolContext = {
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: Conversa;
  mensagem_id: string;
  request_id: string;
};

export type DispatchResult = unknown | { error: string; details?: unknown };

type FieldType = 'string' | 'number' | 'boolean';
type FieldTypeMap = { string: string; number: number; boolean: boolean };

/**
 * Safely narrow a single field from a Zod-validated args object whose runtime
 * shape varies per tool. Zod has already validated the value against the
 * tool's schema; this helper just performs a typeof check before exposing the
 * field to the dispatcher's cross-tool code paths (entidade_id, valor,
 * dual_approval_granted, file_sha256).
 */
type UnknownBag = { [k: string]: unknown };

function pickToolField<K extends FieldType>(
  args: unknown,
  key: string,
  type: K,
): FieldTypeMap[K] | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const bag = args as UnknownBag;
  const v = bag[key];
  return typeof v === type ? (v as FieldTypeMap[K]) : undefined;
}

export async function dispatchTool(input: {
  tool: string;
  args: unknown;
  ctx: ToolContext;
}): Promise<DispatchResult> {
  const tool = REGISTRY[input.tool] as AnyTool | undefined;
  if (!tool) return { error: 'unknown_tool', details: { tool: input.tool } };

  // Codex review #105 (medium): kill-switch em runtime. `REGISTRY` é
  // construído no module-load; quando um flag é killado depois, processos
  // já em execução ainda exporiam (e executariam) o tool sem essa checagem.
  // Verifica AQUI, antes de auth e idempotência, para que o flag desligado
  // bloqueie execução imediatamente — incluindo retries de tools cacheadas.
  // Per-tool `feature_flag` é mais específico que o gate KSM genérico, então
  // vem primeiro e retorna o erro tipado `feature_disabled` com o flag name.
  if (tool.feature_flag !== undefined && !featureFlags.isEnabled(tool.feature_flag)) {
    return {
      error: 'feature_disabled',
      details: { tool: tool.name, feature_flag: tool.feature_flag },
    };
  }

  // P10a (review #104 high): runtime feature-flag gate genérico (KSM
  // propose_* tools). A killed feature flag must block the handler
  // in-flight, not just hide the schema. Without this, the LLM could
  // still call propose_* during a canary rollback and produce rows whose
  // lifecycle columns may not exist in the database yet.
  if (!isToolEnabled(input.tool)) {
    return {
      error: 'tool_disabled',
      details: { tool: input.tool, reason: 'feature_flag_off' },
    };
  }

  const parsed = tool.input_schema.safeParse(input.args);
  if (!parsed.success) {
    return { error: 'invalid_args', details: parsed.error.issues };
  }
  const args = parsed.data;

  const entity_id =
    pickToolField<'string'>(args, 'entidade_id', 'string') ?? input.ctx.scope.entidades[0];
  if (!entity_id) return { error: 'no_entity_in_scope' };

  const resolved = input.ctx.scope.byEntity.get(entity_id);

  // Constitutional rules apply BEFORE per-action permission checks: hard
  // limits, dual-approval gates and cross-entity guards must short-circuit
  // even if the profile would otherwise authorize the action.
  const violation = constitutionalCheck({
    intent: { tool: tool.name, args },
    pessoa: input.ctx.pessoa,
    resolved: resolved ?? null,
    scope: { entidades: input.ctx.scope.entidades },
    dual_approval_granted:
      pickToolField<'boolean'>(args, 'dual_approval_granted', 'boolean') === true,
  });
  if (violation) {
    await audit({
      acao: 'unauthorized_access_attempt',
      pessoa_id: input.ctx.pessoa.id,
      conversa_id: input.ctx.conversa.id,
      mensagem_id: input.ctx.mensagem_id,
      metadata: { tool: tool.name, violation },
    });
    if (violation.kind === 'forbidden') {
      return { error: 'forbidden', details: { rule_id: violation.rule_id, reason: violation.reason } };
    }
    return {
      error: 'requires_dual_approval',
      details: { reason: violation.reason },
    };
  }

  for (const action of tool.required_actions as ActionKey[]) {
    const allow = canAct({
      pessoa: input.ctx.pessoa,
      resolved: resolved ?? null,
      action,
      valor: pickToolField<'number'>(args, 'valor', 'number'),
    });
    if (!allow.allowed) {
      await audit({
        acao: 'unauthorized_access_attempt',
        pessoa_id: input.ctx.pessoa.id,
        conversa_id: input.ctx.conversa.id,
        mensagem_id: input.ctx.mensagem_id,
        metadata: { tool: tool.name, action, reason: allow.reason },
      });
      return { error: 'forbidden', details: { reason: allow.reason } };
    }
  }

  if (tool.redis_required && !isRedisConnected()) {
    return { error: 'redis_unavailable_blocked' };
  }

  const file_sha256 = pickToolField<'string'>(args, 'file_sha256', 'string');
  const idempotency_key = computeIdempotencyKey({
    pessoa_id: input.ctx.pessoa.id,
    entity_id,
    tool_name: tool.name,
    operation_type: tool.operation_type,
    payload: args,
    file_sha256,
  });

  const cached = await idempotencyRepo.lookup(idempotency_key);
  if (cached !== null) {
    logger.debug({ tool: tool.name, idempotency_key }, 'tool.idempotency_hit');
    return cached;
  }

  let result: unknown;
  try {
    result = await tool.handler(args, {
      pessoa: input.ctx.pessoa,
      scope: input.ctx.scope,
      conversa: input.ctx.conversa,
      mensagem_id: input.ctx.mensagem_id,
      request_id: input.ctx.request_id,
      idempotency_key,
    });
  } catch (err) {
    logger.error({ err, tool: tool.name }, 'tool.execution_failed');
    return { error: 'execution_failed', details: { cause: (err as Error).message } };
  }

  const out = tool.output_schema.safeParse(result);
  if (!out.success) {
    logger.error({ tool: tool.name, issues: out.error.issues }, 'tool.output_invalid');
    return { error: 'execution_failed', details: { cause: 'output_schema_violation' } };
  }

  await idempotencyRepo.store({
    key: idempotency_key,
    tool_name: tool.name,
    operation_type: tool.operation_type,
    pessoa_id: input.ctx.pessoa.id,
    entity_id,
    payload_hash: idempotency_key,
    file_sha256,
    resultado: out.data,
  });
  await audit({
    acao: tool.audit_action,
    pessoa_id: input.ctx.pessoa.id,
    conversa_id: input.ctx.conversa.id,
    mensagem_id: input.ctx.mensagem_id,
    entidade_alvo: entity_id,
    alvo_id: tool.extractAlvoId?.(out.data) ?? null,
    metadata: { tool: tool.name },
  });
  return out.data;
}
