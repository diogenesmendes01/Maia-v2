/**
 * Issue #469 — objectivesRouter unit tests (work loop v1).
 *
 * Gates do router: papel (owner/founder para mutações), escopo tenant+agent,
 * kind válido, tarefas manuais só em objetivo ativo do kind manual, e a
 * resolução humana de exceções (waiting_human → done/failed) com auditoria.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { objectivesRouter } from '@/admin-ui/trpc/routers/objectives.js';

const OBJ_UUID = '33333333-3333-4333-8333-333333333333';
const TASK_UUID = '44444444-4444-4444-8444-444444444444';

function makeCtx(
  role: string,
  opts?: {
    agent?: { id: string; tenant_id: string } | null;
    objective?: { id: string; status: string; kind: string } | null;
    task?: { id: string; status: string } | null;
  },
) {
  const audit: Array<Record<string, unknown>> = [];
  const transitions: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];

  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      agentsRepo: {
        async findById(_id: string) {
          return opts?.agent === undefined
            ? { id: 'agent-a', tenant_id: 'tenant-A' }
            : opts.agent;
        },
      },
      adminAuditLogRepo: {
        async append(row: Record<string, unknown>) {
          audit.push(row);
          return row;
        },
      },
      objectivesRepo: {
        async create(args: Record<string, unknown>) {
          created.push(args);
          return { id: OBJ_UUID, ...args, status: 'active', created_at: new Date() };
        },
        async findById(_args: Record<string, unknown>) {
          return opts?.objective === undefined
            ? { id: OBJ_UUID, status: 'active', kind: 'manual' }
            : opts.objective;
        },
        async listByAgent() {
          return [];
        },
        async setStatus(args: Record<string, unknown>) {
          return opts?.objective === null ? null : { id: args.objective_id, ...args };
        },
        async listTasks() {
          return [];
        },
        async findTaskById(_args: Record<string, unknown>) {
          return opts?.task === undefined
            ? { id: TASK_UUID, status: 'waiting_human' }
            : opts.task;
        },
        async upsertTask(args: Record<string, unknown>) {
          created.push(args);
          return { id: TASK_UUID, ...args, status: 'pending' };
        },
        async transitionTask(args: Record<string, unknown>) {
          transitions.push(args);
        },
        async listExceptionsByTenant() {
          return [];
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...roles: string[]) => {
      if (!roles.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `role ${role} not allowed` });
      }
    },
  };
  return { ctx, audit, transitions, created };
}

describe('objectives.create', () => {
  it('creates and audits (owner)', async () => {
    const { ctx, audit, created } = makeCtx('owner');
    const caller = objectivesRouter.createCaller(ctx);
    const res = await caller.create({
      agentId: 'agent-a',
      kind: 'manual',
      title: 'Validar o ciclo',
      params: {},
    });
    expect(res.id).toBe(OBJ_UUID);
    expect(created[0]).toMatchObject({ kind: 'manual', created_by: 'user-1' });
    expect(audit[0]).toMatchObject({ action: 'objective_create' });
  });

  it('rejects unknown kind (Zod)', async () => {
    const { ctx } = makeCtx('owner');
    const caller = objectivesRouter.createCaller(ctx);
    await expect(
      caller.create({ agentId: 'agent-a', kind: 'inadimplencia', title: 'ainda não', params: {} }),
    ).rejects.toThrowError(/unknown objective kind/);
  });

  it('rejects analyst (role gate)', async () => {
    const { ctx } = makeCtx('analyst');
    const caller = objectivesRouter.createCaller(ctx);
    await expect(
      caller.create({ agentId: 'agent-a', kind: 'manual', title: 'sem papel', params: {} }),
    ).rejects.toThrowError(/FORBIDDEN|not allowed/);
  });

  it('rejects agent from another tenant as NOT_FOUND', async () => {
    const { ctx } = makeCtx('owner', { agent: { id: 'x', tenant_id: 'tenant-B' } });
    const caller = objectivesRouter.createCaller(ctx);
    await expect(
      caller.create({ agentId: 'x', kind: 'manual', title: 'cruzando tenant', params: {} }),
    ).rejects.toThrowError(/Agent not found/);
  });
});

describe('objectives.createTask', () => {
  it('refuses tasks on paused objectives (PRECONDITION_FAILED)', async () => {
    const { ctx } = makeCtx('owner', {
      objective: { id: OBJ_UUID, status: 'paused', kind: 'manual' },
    });
    const caller = objectivesRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.createTask({
        agentId: 'agent-a',
        objectiveId: OBJ_UUID,
        title: 'tarefa em objetivo pausado',
        flow: 'auto',
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  it('refuses manual tasks on perceptor kinds (PRECONDITION_FAILED)', async () => {
    const { ctx } = makeCtx('founder', {
      objective: { id: OBJ_UUID, status: 'active', kind: 'inadimplencia' },
    });
    const caller = objectivesRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.createTask({
        agentId: 'agent-a',
        objectiveId: OBJ_UUID,
        title: 'furando o perceptor',
        flow: 'auto',
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).code).toBe('PRECONDITION_FAILED');
  });
});

describe('objectives.resolveTask', () => {
  it('resolves a waiting_human task with audited note', async () => {
    const { ctx, audit, transitions } = makeCtx('owner');
    const caller = objectivesRouter.createCaller(ctx);
    const res = await caller.resolveTask({
      agentId: 'agent-a',
      taskId: TASK_UUID,
      resolution: 'done',
      note: 'Autorizei o desconto solicitado.',
    });
    expect(res.ok).toBe(true);
    expect(transitions[0]).toMatchObject({ task_id: TASK_UUID, status: 'done' });
    expect(audit[0]).toMatchObject({ action: 'objective_task_resolved' });
  });

  it('CONFLICT when the task is not waiting_human anymore', async () => {
    const { ctx } = makeCtx('owner', { task: { id: TASK_UUID, status: 'done' } });
    const caller = objectivesRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.resolveTask({
        agentId: 'agent-a',
        taskId: TASK_UUID,
        resolution: 'done',
        note: 'tarde demais',
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TRPCError).code).toBe('CONFLICT');
  });
});
