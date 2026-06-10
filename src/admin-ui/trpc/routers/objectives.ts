/**
 * Work loop router (issue #469 — v1).
 *
 * Objetivos são mudança de comportamento: criação/pausa/arquivamento exigem
 * owner/founder e são AUDITADOS (admin_audit_log, mesma transação não é
 * necessária aqui — auditamos via append após a escrita, como tenants.create).
 * Tarefas do kind `manual` são criadas pelo console; `resolveTask` é a ação
 * humana que destrava a fila de exceções (waiting_human → done/failed).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { OBJECTIVE_KIND_IDS } from '../../../objectives/kinds.js';

const AgentIdSchema = z.string().min(1).max(64);

const CreateObjectiveInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  kind: z.string().refine((k) => OBJECTIVE_KIND_IDS.includes(k), {
    message: 'unknown objective kind',
  }),
  title: z.string().min(3).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
});

const SetStatusInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  objectiveId: z.string().uuid(),
  status: z.enum(['active', 'paused', 'archived']),
});

const ListInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
});

const ListTasksInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  objectiveId: z.string().uuid().optional(),
  status: z
    .enum(['pending', 'running', 'waiting_human', 'done', 'failed', 'cancelled'])
    .optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

const CreateTaskInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  objectiveId: z.string().uuid(),
  title: z.string().min(3).max(200),
  // v1 (kind manual): 'auto' conclui na execução; 'exception' valida a fila
  // de exceções (para em waiting_human até resolveTask).
  flow: z.enum(['auto', 'exception']).default('auto'),
});

const ResolveTaskInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  taskId: z.string().uuid(),
  resolution: z.enum(['done', 'failed']),
  note: z.string().min(3).max(2000),
});

const ListExceptionsInput = z.object({ tenantId: z.string().optional() });

async function assertAgent(
  ctx: { repos: typeof import('../../../db/repositories.js') },
  tenantId: string,
  agentId: string,
) {
  const agent = await ctx.repos.agentsRepo.findById(agentId);
  if (!agent || agent.tenant_id !== tenantId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
  }
}

export const objectivesRouter = router({
  list: protectedProcedure.input(ListInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const items = await ctx.repos.objectivesRepo.listByAgent({
      tenant_id: tenantId,
      agent_id: input.agentId,
    });
    return { items };
  }),

  create: protectedProcedure.input(CreateObjectiveInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const objective = await ctx.repos.objectivesRepo.create({
      tenant_id: tenantId,
      agent_id: input.agentId,
      kind: input.kind,
      title: input.title,
      params: input.params,
      created_by: ctx.userId,
    });
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'objective_create',
      resource_type: 'agent_objective',
      resource_id: objective.id,
      change_summary: {
        agent_id: input.agentId,
        kind: input.kind,
        title: input.title,
      },
    });
    return objective;
  }),

  setStatus: protectedProcedure.input(SetStatusInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const updated = await ctx.repos.objectivesRepo.setStatus({
      tenant_id: tenantId,
      agent_id: input.agentId,
      objective_id: input.objectiveId,
      status: input.status,
    });
    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Objective not found' });
    }
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'objective_set_status',
      resource_type: 'agent_objective',
      resource_id: updated.id,
      change_summary: { agent_id: input.agentId, status: input.status },
    });
    return updated;
  }),

  listTasks: protectedProcedure.input(ListTasksInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const items = await ctx.repos.objectivesRepo.listTasks({
      tenant_id: tenantId,
      agent_id: input.agentId,
      objective_id: input.objectiveId,
      status: input.status,
      limit: input.limit,
    });
    return { items };
  }),

  createTask: protectedProcedure.input(CreateTaskInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const objective = await ctx.repos.objectivesRepo.findById({
      tenant_id: tenantId,
      agent_id: input.agentId,
      objective_id: input.objectiveId,
    });
    if (!objective) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Objective not found' });
    }
    if (objective.status !== 'active') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Objective is '${objective.status}' — reactivate it before adding tasks.`,
      });
    }
    if (objective.kind !== 'manual') {
      // Kinds com perceptor geram as próprias tarefas — criar manualmente
      // furaria a idempotência do perceptor.
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Tasks for kind '${objective.kind}' are created by its perceptor, not manually.`,
      });
    }
    const task = await ctx.repos.objectivesRepo.upsertTask({
      tenant_id: tenantId,
      agent_id: input.agentId,
      objective_id: input.objectiveId,
      natural_key: `manual:${crypto.randomUUID()}`,
      title: input.title,
      payload: { flow: input.flow },
    });
    if (!task) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Task insert failed' });
    }
    return task;
  }),

  /** Ação humana sobre a fila de exceções (waiting_human → done/failed). */
  resolveTask: protectedProcedure.input(ResolveTaskInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    await assertAgent(ctx, tenantId, input.agentId);
    const task = await ctx.repos.objectivesRepo.findTaskById({
      tenant_id: tenantId,
      agent_id: input.agentId,
      task_id: input.taskId,
    });
    if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
    if (task.status !== 'waiting_human') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Task is '${task.status}', not waiting_human — refresh and retry.`,
      });
    }
    await ctx.repos.objectivesRepo.transitionTask({
      task_id: task.id,
      status: input.resolution,
      outcome: { resolved_by: ctx.userId, note: input.note },
    });
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'objective_task_resolved',
      resource_type: 'objective_task',
      resource_id: task.id,
      change_summary: {
        agent_id: input.agentId,
        resolution: input.resolution,
        note: input.note,
      },
    });
    return { ok: true };
  }),

  listExceptions: protectedProcedure
    .input(ListExceptionsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await ctx.repos.objectivesRepo.listExceptionsByTenant({
        tenant_id: tenantId,
      });
      return { items };
    }),
});
