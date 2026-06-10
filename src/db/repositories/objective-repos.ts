/**
 * Work loop v1 repos (issue #469 — migration 088).
 *
 * Métodos com tenant_id + agent_id EXPLÍCITOS (sem ALS) — chamáveis do
 * admin-ui e dos workers. Toda leitura/escrita escopada por (tenant, agent);
 * um id de objetivo/tarefa sozinho nunca cruza tenants (invariante 1).
 *
 * `claimNextPendingTask` usa FOR UPDATE SKIP LOCKED (mesmo padrão do
 * playground): múltiplos workers cooperam sem duplo processamento.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import {
  agent_objectives,
  objective_tasks,
  type AgentObjective,
  type ObjectiveTask,
  type ObjectiveStatus,
  type ObjectiveTaskStatus,
} from '../schema.js';

export const objectivesRepo = {
  async create(args: {
    tenant_id: string;
    agent_id: string;
    kind: string;
    title: string;
    params: Record<string, unknown>;
    created_by: string;
  }): Promise<AgentObjective> {
    const [row] = await db
      .insert(agent_objectives)
      .values({
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        kind: args.kind,
        title: args.title,
        params: args.params,
        created_by: args.created_by,
      })
      .returning();
    return row!;
  },

  async findById(args: {
    tenant_id: string;
    agent_id: string;
    objective_id: string;
  }): Promise<AgentObjective | null> {
    const rows = await db
      .select()
      .from(agent_objectives)
      .where(
        and(
          eq(agent_objectives.id, args.objective_id),
          eq(agent_objectives.tenant_id, args.tenant_id),
          eq(agent_objectives.agent_id, args.agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByAgent(args: {
    tenant_id: string;
    agent_id: string;
  }): Promise<AgentObjective[]> {
    return db
      .select()
      .from(agent_objectives)
      .where(
        and(
          eq(agent_objectives.tenant_id, args.tenant_id),
          eq(agent_objectives.agent_id, args.agent_id),
        ),
      )
      .orderBy(desc(agent_objectives.created_at));
  },

  async setStatus(args: {
    tenant_id: string;
    agent_id: string;
    objective_id: string;
    status: ObjectiveStatus;
  }): Promise<AgentObjective | null> {
    const [row] = await db
      .update(agent_objectives)
      .set({ status: args.status, updated_at: new Date() })
      .where(
        and(
          eq(agent_objectives.id, args.objective_id),
          eq(agent_objectives.tenant_id, args.tenant_id),
          eq(agent_objectives.agent_id, args.agent_id),
        ),
      )
      .returning();
    return row ?? null;
  },

  /**
   * Upsert idempotente do perceptor: índice parcial único
   * (objective_id, natural_key) WHERE viva ⇒ ON CONFLICT DO NOTHING.
   * Retorna a tarefa criada ou null quando já existe uma viva igual.
   */
  async upsertTask(args: {
    tenant_id: string;
    agent_id: string;
    objective_id: string;
    natural_key: string;
    title: string;
    payload: Record<string, unknown>;
  }): Promise<ObjectiveTask | null> {
    const inserted = await db
      .insert(objective_tasks)
      .values({
        objective_id: args.objective_id,
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        natural_key: args.natural_key,
        title: args.title,
        payload: args.payload,
      })
      .onConflictDoNothing()
      .returning();
    return inserted[0] ?? null;
  },

  async listTasks(args: {
    tenant_id: string;
    agent_id: string;
    objective_id?: string;
    status?: ObjectiveTaskStatus;
    limit?: number;
  }): Promise<ObjectiveTask[]> {
    const conditions = [
      eq(objective_tasks.tenant_id, args.tenant_id),
      eq(objective_tasks.agent_id, args.agent_id),
    ];
    if (args.objective_id) conditions.push(eq(objective_tasks.objective_id, args.objective_id));
    if (args.status) conditions.push(eq(objective_tasks.status, args.status));
    return db
      .select()
      .from(objective_tasks)
      .where(and(...conditions))
      .orderBy(desc(objective_tasks.created_at))
      .limit(args.limit ?? 100);
  },

  async findTaskById(args: {
    tenant_id: string;
    agent_id: string;
    task_id: string;
  }): Promise<ObjectiveTask | null> {
    const rows = await db
      .select()
      .from(objective_tasks)
      .where(
        and(
          eq(objective_tasks.id, args.task_id),
          eq(objective_tasks.tenant_id, args.tenant_id),
          eq(objective_tasks.agent_id, args.agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /* ------------------------------------------------------------------ */
  /* Worker side                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Claim atômico da tarefa pendente mais antiga + seu objetivo. Tarefa de
   * objetivo não-ativo (pausado/arquivado) é CANCELADA dentro do claim
   * (guardrail 4 da spec) e o claim segue para a próxima.
   */
  async claimNextPendingTask(): Promise<{
    task: ObjectiveTask;
    objective: AgentObjective;
  } | null> {
    return await withTx(async (tx) => {
      const claimed = await tx.execute<{ id: string }>(sql`
        UPDATE objective_tasks
           SET status = 'running'
         WHERE id = (
           SELECT id FROM objective_tasks
            WHERE status = 'pending'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id
      `);
      const claimedId = claimed.rows[0]?.id;
      if (!claimedId) return null;

      const taskRows = await tx
        .select()
        .from(objective_tasks)
        .where(eq(objective_tasks.id, claimedId))
        .limit(1);
      const task = taskRows[0];
      if (!task) return null;

      const objRows = await tx
        .select()
        .from(agent_objectives)
        .where(eq(agent_objectives.id, task.objective_id))
        .limit(1);
      const objective = objRows[0];
      if (!objective || objective.status !== 'active') {
        // Objetivo sumiu/pausado/arquivado — tarefa órfã é cancelada, nunca
        // executada (spec §7.4).
        await tx
          .update(objective_tasks)
          .set({
            status: 'cancelled',
            error_detail: objective ? `objective_${objective.status}` : 'objective_missing',
            completed_at: new Date(),
          })
          .where(eq(objective_tasks.id, claimedId));
        return null;
      }
      return { task, objective };
    });
  },

  async transitionTask(args: {
    task_id: string;
    status: Extract<ObjectiveTaskStatus, 'done' | 'failed' | 'waiting_human' | 'pending'>;
    outcome?: Record<string, unknown> | null;
    error_detail?: string | null;
    procedure_execution_id?: string | null;
    pending_question_id?: string | null;
  }): Promise<void> {
    const terminal = args.status === 'done' || args.status === 'failed';
    await db
      .update(objective_tasks)
      .set({
        status: args.status,
        ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
        ...(args.error_detail !== undefined
          ? { error_detail: args.error_detail?.slice(0, 2000) ?? null }
          : {}),
        ...(args.procedure_execution_id !== undefined
          ? { procedure_execution_id: args.procedure_execution_id }
          : {}),
        ...(args.pending_question_id !== undefined
          ? { pending_question_id: args.pending_question_id }
          : {}),
        completed_at: terminal ? new Date() : null,
      })
      .where(eq(objective_tasks.id, args.task_id));
  },

  /** Exceções (waiting_human) de todo o tenant — para o bloco do dashboard. */
  async listExceptionsByTenant(args: {
    tenant_id: string;
    limit?: number;
  }): Promise<ObjectiveTask[]> {
    return db
      .select()
      .from(objective_tasks)
      .where(
        and(
          eq(objective_tasks.tenant_id, args.tenant_id),
          eq(objective_tasks.status, 'waiting_human'),
        ),
      )
      .orderBy(asc(objective_tasks.created_at))
      .limit(args.limit ?? 50);
  },
};
