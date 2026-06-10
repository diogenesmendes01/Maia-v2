/**
 * Work loop — worker de execução (issue #469, spec §3).
 *
 * Drena `objective_tasks` pendentes (Postgres-as-queue, SKIP LOCKED) por até
 * ~50s por tick de 1min — mesmo padrão drain-inside-tick do playground/
 * outbox_drain. Cada tarefa executa sob `runWithTenantContext` derivado da
 * própria row; o executor vem do registry tipado (src/objectives/kinds.ts).
 *
 * Falha de executor NUNCA deixa tarefa presa em 'running' — vira 'failed'
 * com error_detail, visível no console. Cada execução é auditada
 * (objective_task_executed) — invariante 4.
 */
import { logger } from '@/lib/logger.js';
import { objectivesRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { getObjectiveKind } from '@/objectives/kinds.js';
import { audit } from '@/governance/audit.js';

const DRAIN_BUDGET_MS = 50_000;
const IDLE_POLL_MS = 3_000;

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runObjectiveExecuteWorker(): Promise<void> {
  if (running) return;
  running = true;
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  try {
    while (Date.now() < deadline) {
      const claimed = await objectivesRepo.claimNextPendingTask();
      if (!claimed) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const { task, objective } = claimed;
      try {
        const kind = getObjectiveKind(objective.kind);
        if (!kind) {
          // Kind desconhecido (registro removido entre deploys) — fail-closed.
          await objectivesRepo.transitionTask({
            task_id: task.id,
            status: 'failed',
            error_detail: `unknown_objective_kind: ${objective.kind}`,
          });
          continue;
        }

        const result = await runWithTenantContext(
          { tenant_id: task.tenant_id, agent_id: task.agent_id },
          async () => {
            const r = await kind.execute({ objective, task });
            await audit({
              acao: 'objective_task_executed',
              alvo_id: task.id,
              metadata: {
                objective_id: objective.id,
                objective_kind: objective.kind,
                task_natural_key: task.natural_key,
                transition: r.transition,
              },
            });
            return r;
          },
        );

        if (result.transition === 'done') {
          await objectivesRepo.transitionTask({
            task_id: task.id,
            status: 'done',
            outcome: result.outcome,
          });
        } else if (result.transition === 'waiting_human') {
          await objectivesRepo.transitionTask({
            task_id: task.id,
            status: 'waiting_human',
            outcome: result.outcome ?? null,
          });
        } else {
          await objectivesRepo.transitionTask({
            task_id: task.id,
            status: 'failed',
            error_detail: result.error_detail,
          });
        }
      } catch (e) {
        await objectivesRepo.transitionTask({
          task_id: task.id,
          status: 'failed',
          error_detail: e instanceof Error ? e.message : String(e),
        });
        logger.error(
          { err: e, task_id: task.id, tenant_id: task.tenant_id, agent_id: task.agent_id },
          'objectives.task_failed',
        );
      }
    }
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ */
/* Percepção (spec §3 — objective_perceive)                            */
/* ------------------------------------------------------------------ */

/**
 * Para cada objetivo ativo cujo kind declara um perceptor, materializa
 * tarefas idempotentes (upsert por natural_key — o índice parcial único
 * garante no máximo UMA tarefa viva por chave). v1 não tem kind com
 * perceptor (o `manual` recebe tarefas pelo console), então cada tick é
 * barato; a v2 (`inadimplencia`) pluga aqui sem tocar no worker.
 */
export async function runObjectivePerceiveWorker(): Promise<void> {
  const { db } = await import('@/db/client.js');
  const { agent_objectives } = await import('@/db/schema.js');
  const { eq } = await import('drizzle-orm');

  const actives = await db
    .select()
    .from(agent_objectives)
    .where(eq(agent_objectives.status, 'active'));

  for (const objective of actives) {
    const kind = getObjectiveKind(objective.kind);
    if (!kind?.perceive) continue;
    try {
      const tasks = await runWithTenantContext(
        { tenant_id: objective.tenant_id, agent_id: objective.agent_id },
        async () => kind.perceive!(objective),
      );
      for (const t of tasks) {
        await objectivesRepo.upsertTask({
          tenant_id: objective.tenant_id,
          agent_id: objective.agent_id,
          objective_id: objective.id,
          natural_key: t.natural_key,
          title: t.title,
          payload: t.payload,
        });
      }
    } catch (e) {
      logger.error(
        { err: e, objective_id: objective.id, kind: objective.kind },
        'objectives.perceive_failed',
      );
    }
  }
}
