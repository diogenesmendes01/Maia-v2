/**
 * Work loop v1 repos (issue #469 — migration 088).
 *
 * Métodos com tenant_id + agent_id EXPLÍCITOS (sem ALS) — chamáveis do
 * admin-ui e dos workers. Toda leitura/escrita escopada por (tenant, agent);
 * um id de objetivo/tarefa sozinho nunca cruza tenants (invariante 1).
 *
 * `claimNextPendingTask` usa FOR UPDATE SKIP LOCKED (mesmo padrão do
 * playground): múltiplos workers cooperam sem duplo processamento.
 *
 * LEASE E FENCING (migração 138, issue #469 fatia A). Até a 138 o claim
 * marcava `status='running'` e NADA MAIS: sem dono, sem prazo, sem token. Um
 * SIGKILL entre o claim e `transitionTask` prendia a tarefa em `running` para
 * sempre — e o índice parcial único da 088 considera `running` uma tarefa
 * VIVA, então nem o perceptor podia recriá-la. Agora:
 *
 *   - o claim carimba `claimed_by`/`claimed_at`/`lease_expires_at` e um
 *     `claim_token` novo, e incrementa `claim_attempts`;
 *   - `transitionTask` EXIGE tenant+agent e (no caminho do worker) o token do
 *     claim vencedor — um worker de lease vencida não sobrescreve mais quem
 *     assumiu a tarefa depois dele;
 *   - `reclaimExpiredTaskLeases` devolve para `pending` a tarefa cujo dono
 *     sumiu, com TETO: acima de `max_attempts` ela vai para `failed`, para que
 *     uma poison task que derruba o processo não seja reanimada eternamente.
 */
import { randomUUID } from 'node:crypto';
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
   *
   * O TARGET é EXPLÍCITO de propósito (issue #469 fatia A). Um
   * `onConflictDoNothing()` sem alvo engole conflito de QUALQUER índice único
   * da tabela — inclusive de um índice futuro que nada tenha a ver com a
   * idempotência do perceptor. Nesse dia um bug de unicidade viraria silêncio
   * (a função devolve `null`, que o chamador lê como "já existia"). Com o
   * alvo e o predicado parciais declarados, só o conflito PREVISTO é
   * absorvido; qualquer outro estoura alto. A fatia B acrescenta índice novo
   * a esta tabela — o alvo precisa estar aqui ANTES disso.
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
      .onConflictDoNothing({
        target: [objective_tasks.objective_id, objective_tasks.natural_key],
        where: sql`status NOT IN ('done', 'failed', 'cancelled')`,
      })
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
   *
   * O claim agora carimba o LEASE (migração 138): dono, prazo e um
   * `claim_token` novo, devolvido ao chamador. Quem executa a tarefa precisa
   * apresentar esse token para transicioná-la — é o que impede o worker cuja
   * lease foi reclamada de sobrescrever a decisão de quem assumiu depois.
   *
   * `claim_attempts` é incrementado AQUI, não no reaper: o que interessa
   * contar é quantas vezes esta tarefa já entrou em execução, inclusive a
   * primeira. Um reaper que contasse só as próprias reanimações daria uma
   * tentativa extra de graça a cada poison task.
   */
  async claimNextPendingTask(args: {
    worker_id: string;
    lease_seconds: number;
  }): Promise<{
    task: ObjectiveTask;
    objective: AgentObjective;
    claim_token: string;
  } | null> {
    const claimToken = randomUUID();
    return await withTx(async (tx) => {
      const claimed = await tx.execute<{ id: string }>(sql`
        UPDATE objective_tasks
           SET status = 'running',
               claimed_by = ${args.worker_id},
               claimed_at = now(),
               lease_expires_at = now() + (${args.lease_seconds} || ' seconds')::interval,
               claim_token = ${claimToken},
               claim_attempts = claim_attempts + 1
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
            // O lease morre junto: uma tarefa terminal com token seria um
            // lease fantasma, e o CHECK da 138 recusa a incoerência.
            claimed_by: null,
            claimed_at: null,
            lease_expires_at: null,
            claim_token: null,
          })
          .where(eq(objective_tasks.id, claimedId));
        return null;
      }
      return { task, objective, claim_token: claimToken };
    });
  },

  /**
   * Transição de estado da tarefa. TRÊS predicados, todos obrigatórios ou
   * opcionais por razão declarada (issue #469 fatia A):
   *
   *  - `tenant_id` + `agent_id`: OBRIGATÓRIOS. É o invariante 1, não
   *    otimização. Antes disto o UPDATE escrevia só por `id`, então um id
   *    vazado (log, URL, payload de outro tenant) transicionava a tarefa
   *    alheia. Nenhum chamador precisava disso: os dois já tinham o escopo
   *    em mãos.
   *  - `expect_claim_token`: o FENCING. O worker passa o token que o claim
   *    lhe deu; se o reaper já reclamou a lease (token novo) ou a tarefa já
   *    saiu de `running` (token nulo), o UPDATE casa ZERO linhas e o
   *    chamador descobre pelo retorno `false`. Sem isto o reaper seria uma
   *    corrida nova em vez de uma correção.
   *  - `expect_status`: CAS opcional para o caminho humano (console), que
   *    lê a tarefa e escreve depois — sem o predicado, duas abas resolvendo
   *    a mesma exceção sobrescrevem uma à outra.
   *
   * Retorna `true` quando a linha mudou. Um `false` NÃO é erro do banco: é a
   * informação de que o predicado não casou, e é o chamador que decide se
   * isso é benigno (perdeu a corrida) ou digno de log.
   */
  async transitionTask(args: {
    tenant_id: string;
    agent_id: string;
    task_id: string;
    status: Extract<ObjectiveTaskStatus, 'done' | 'failed' | 'waiting_human' | 'pending'>;
    /** Fencing: exige que a row ainda carregue este token de claim. */
    expect_claim_token?: string;
    /** CAS de status para o caminho sem claim (console). */
    expect_status?: ObjectiveTaskStatus;
    outcome?: Record<string, unknown> | null;
    error_detail?: string | null;
    procedure_execution_id?: string | null;
    pending_question_id?: string | null;
  }): Promise<boolean> {
    const terminal = args.status === 'done' || args.status === 'failed';
    const conditions = [
      eq(objective_tasks.id, args.task_id),
      eq(objective_tasks.tenant_id, args.tenant_id),
      eq(objective_tasks.agent_id, args.agent_id),
    ];
    if (args.expect_claim_token !== undefined) {
      conditions.push(eq(objective_tasks.claim_token, args.expect_claim_token));
    }
    if (args.expect_status !== undefined) {
      conditions.push(eq(objective_tasks.status, args.expect_status));
    }
    const updated = await db
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
        // Sair de `running` LIBERA o lease, sempre. Um token sobrevivente
        // seria reanimável pelo reaper, e o CHECK da 138 recusa a incoerência.
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        claim_token: null,
      })
      .where(and(...conditions))
      .returning({ id: objective_tasks.id });
    return updated.length > 0;
  },

  /* ------------------------------------------------------------------ */
  /* Reaper de lease (migração 138)                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Devolve para a fila a tarefa cujo dono sumiu — o conserto do defeito
   * central da fatia A: sem isto um SIGKILL entre o claim e a transição
   * prendia a tarefa em `running` PARA SEMPRE, e o índice parcial único da
   * 088 (que considera `running` uma tarefa VIVA) impedia até o perceptor de
   * recriá-la.
   *
   * CROSS-TENANT de propósito, como a varredura de lease vencida da 114 e da
   * 131: o processo que morreu pode ter sido o de qualquer tenant, e a
   * pergunta "quem perdeu o dono?" não tem contexto de tenant para ser feita
   * dentro. O escopo por tenant continua valendo em toda leitura de console e
   * em toda escrita de `transitionTask`.
   *
   * TETO (`max_attempts`): uma tarefa que derruba o processo a cada execução
   * seria reanimada eternamente por um reaper ingênuo — o crash-loop mais
   * caro que existe, porque é invisível. Acima do teto ela vai para `failed`
   * com o motivo na `error_detail`, e aparece no console como exceção. Perder
   * uma tarefa e VER o motivo é melhor que um loop silencioso.
   *
   * O `claim_token` da row é sobrescrito/zerado aqui — é o que faz o worker
   * pendurado perder o direito de escrever (o `expect_claim_token` dele deixa
   * de casar).
   */
  async reclaimExpiredTaskLeases(args: {
    limit: number;
    max_attempts: number;
  }): Promise<{ requeued: string[]; failed: string[] }> {
    const rows = await db.execute<{ id: string; new_status: string }>(sql`
      WITH expired AS (
        SELECT id, claim_attempts
          FROM objective_tasks
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < now()
         ORDER BY lease_expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${args.limit}
      )
      UPDATE objective_tasks t
         SET status = CASE
               WHEN e.claim_attempts >= ${args.max_attempts} THEN 'failed'
               ELSE 'pending'
             END,
             error_detail = CASE
               WHEN e.claim_attempts >= ${args.max_attempts}
                 THEN 'lease_expired_after_' || e.claim_attempts || '_claims'
               ELSE t.error_detail
             END,
             completed_at = CASE
               WHEN e.claim_attempts >= ${args.max_attempts} THEN now()
               ELSE NULL
             END,
             claimed_by = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             claim_token = NULL
        FROM expired e
       WHERE t.id = e.id
       RETURNING t.id, t.status AS new_status;
    `);
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const r of rows.rows) {
      (r.new_status === 'failed' ? failed : requeued).push(r.id);
    }
    return { requeued, failed };
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
