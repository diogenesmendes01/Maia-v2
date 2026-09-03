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
 *
 * LEASE (issue #469 fatia A, migração 138). A frase acima só era verdade para
 * a falha que o `try/catch` VÊ. Um SIGKILL, um OOM ou um deploy entre o claim
 * e a transição não passam por catch nenhum: até esta fatia a tarefa ficava em
 * `running` para sempre, invisível, e o índice parcial único da 088 (que trata
 * `running` como tarefa VIVA) impedia o perceptor de recriá-la. Agora o claim
 * carimba um lease com prazo e token, e cada tick começa reclamando as leases
 * vencidas — com teto de tentativas, para que uma poison task que derruba o
 * processo não seja reanimada eternamente.
 *
 * É também o que torna verdadeira a afirmação do `runTick` em
 * `src/workers/index.ts` ("todo job longo aqui já é single-flight por lease de
 * DB"): o guard de sobreposição de lá vale dentro de UM processo; o fencing
 * daqui vale entre réplicas.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { logger } from '@/lib/logger.js';
import { objectivesRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { getObjectiveKind } from '@/objectives/kinds.js';
import { audit } from '@/governance/audit.js';

const DRAIN_BUDGET_MS = 50_000;
const IDLE_POLL_MS = 3_000;

/**
 * Prazo do lease de UMA tarefa (migração 138). Precisa ser MAIOR que a
 * execução mais longa que um kind pode ter e MENOR que o tempo que se aceita
 * esperar por uma tarefa órfã. 5 minutos é folgado para o kind `manual` (que
 * não faz I/O) e continua folgado para um executor que chame o dispatcher.
 *
 * Não há renovação de lease nesta fatia — logo, não há `heartbeat_at` na
 * tabela: uma coluna assim afirmaria um sinal de vida que ninguém emite. Um
 * kind de execução longa entra junto com o renovador, não antes dele.
 */
const TASK_LEASE_SECONDS = 300;

/**
 * Teto de claims por tarefa antes de o reaper desistir dela. Uma tarefa que
 * derruba o processo a cada execução seria reanimada para sempre por um
 * reaper sem teto — crash-loop invisível. No terceiro claim ela vira `failed`
 * com o motivo, e aparece no console.
 */
const MAX_TASK_CLAIM_ATTEMPTS = 3;

/** Quantas leases vencidas são reclamadas por tick. */
const REAP_BATCH = 50;

/**
 * Identidade do dono do lease. `hostname` sozinho não distingue duas réplicas
 * no mesmo host, e o pid é reciclado — o sufixo aleatório por PROCESSO é o
 * que faz `claimed_by` responder "qual processo?" e não "qual máquina?".
 */
const WORKER_ID = `objective-execute@${hostname()}#${process.pid}.${randomUUID().slice(0, 8)}`;

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runObjectiveExecuteWorker(): Promise<void> {
  if (running) return;
  running = true;
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  try {
    // Reaper ANTES do drain: uma tarefa órfã de um processo morto volta para
    // a fila e é reexecutada NESTE tick, não no próximo. Falha do reaper não
    // pode impedir o drain — o trabalho novo continua valendo mesmo quando a
    // varredura de lease quebra.
    try {
      const reaped = await objectivesRepo.reclaimExpiredTaskLeases({
        limit: REAP_BATCH,
        max_attempts: MAX_TASK_CLAIM_ATTEMPTS,
      });
      if (reaped.requeued.length > 0 || reaped.failed.length > 0) {
        logger.warn(
          {
            requeued: reaped.requeued.length,
            failed: reaped.failed.length,
            max_attempts: MAX_TASK_CLAIM_ATTEMPTS,
          },
          'objectives.lease_reclaimed',
        );
      }
    } catch (e) {
      logger.error({ err: e }, 'objectives.lease_reclaim_failed');
    }

    while (Date.now() < deadline) {
      const claimed = await objectivesRepo.claimNextPendingTask({
        worker_id: WORKER_ID,
        lease_seconds: TASK_LEASE_SECONDS,
      });
      if (!claimed) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const { task, objective, claim_token } = claimed;
      const scope = {
        tenant_id: task.tenant_id,
        agent_id: task.agent_id,
        expect_claim_token: claim_token,
      };
      /** Um `false` aqui = lease perdida para o reaper. Nunca silencioso. */
      const transition = async (
        patch: Parameters<typeof objectivesRepo.transitionTask>[0],
      ): Promise<void> => {
        const applied = await objectivesRepo.transitionTask(patch);
        if (!applied) {
          logger.warn(
            {
              task_id: task.id,
              tenant_id: task.tenant_id,
              agent_id: task.agent_id,
              attempted_status: patch.status,
            },
            'objectives.transition_fenced_out',
          );
        }
      };
      try {
        const kind = getObjectiveKind(objective.kind);
        if (!kind) {
          // Kind desconhecido (registro removido entre deploys) — fail-closed.
          await transition({
            ...scope,
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
          await transition({
            ...scope,
            task_id: task.id,
            status: 'done',
            outcome: result.outcome,
          });
        } else if (result.transition === 'waiting_human') {
          await transition({
            ...scope,
            task_id: task.id,
            status: 'waiting_human',
            outcome: result.outcome ?? null,
          });
        } else {
          await transition({
            ...scope,
            task_id: task.id,
            status: 'failed',
            error_detail: result.error_detail,
          });
        }
      } catch (e) {
        await transition({
          ...scope,
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
