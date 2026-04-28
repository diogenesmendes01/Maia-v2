import type { Pessoa, Conversa } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { canAct } from '@/governance/permissions.js';
import { REGISTRY, type AnyTool } from './_registry.js';
import { computeIdempotencyKey } from '@/governance/idempotency.js';
import { idempotencyRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { isRedisConnected } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import type { ActionKey } from '@/governance/audit-actions.js';

export type ToolContext = {
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: Conversa;
  mensagem_id: string;
  request_id: string;
};

export type DispatchResult = unknown | { error: string; details?: unknown };

export async function dispatchTool(input: {
  tool: string;
  args: unknown;
  ctx: ToolContext;
}): Promise<DispatchResult> {
  const tool = REGISTRY[input.tool] as AnyTool | undefined;
  if (!tool) return { error: 'unknown_tool', details: { tool: input.tool } };

  const parsed = tool.input_schema.safeParse(input.args);
  if (!parsed.success) {
    return { error: 'invalid_args', details: parsed.error.issues };
  }
  const args = parsed.data as Record<string, unknown>;

  const entity_id = (args.entidade_id as string | undefined) ?? input.ctx.scope.entidades[0];
  if (!entity_id) return { error: 'no_entity_in_scope' };

  const resolved = input.ctx.scope.byEntity.get(entity_id);
  for (const action of tool.required_actions as ActionKey[]) {
    const allow = canAct({
      pessoa: input.ctx.pessoa,
      resolved: resolved ?? null,
      action,
      valor: typeof args.valor === 'number' ? args.valor : undefined,
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

  const file_sha256 = typeof args.file_sha256 === 'string' ? args.file_sha256 : undefined;
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
    metadata: { tool: tool.name },
  });
  return out.data;
}
