/**
 * Issue #469, fatia A do work loop — lease, fencing e reaper de
 * `objective_tasks`, contra Postgres REAL (migração 138).
 *
 * O DEFEITO que estes testes travam: até a 138 o claim marcava
 * `status='running'` e nada mais. Um SIGKILL entre o claim e a transição
 * deixava a tarefa em `running` PARA SEMPRE — e o índice parcial único da 088
 * (`objective_tasks_live_natural_key_uq`, que trata `running` como tarefa
 * VIVA) impedia até o perceptor de recriá-la. O trabalho sumia em silêncio.
 *
 * As quatro propriedades provadas aqui, e o que cada uma custa se cair:
 *
 *  1. REANIMAÇÃO — lease vencida volta para `pending`, com dono, prazo e
 *     token zerados. Sem isto a tarefa fica presa.
 *  2. NÃO-REANIMAÇÃO — lease VIVA não é tocada (caso de controle). Sem isto
 *     o reaper vira o próprio bug: rouba a tarefa de quem está executando.
 *  3. FENCING — o worker de lease reclamada NÃO consegue mais escrever, e o
 *     worker novo consegue (caso de controle). É isto que impede o agente de
 *     agir DUAS VEZES sobre a mesma tarefa: sem o token, o dono morto
 *     carimbaria `done` sobre o trabalho de quem assumiu depois.
 *  4. TETO — a tarefa que já foi claimada `max_attempts` vezes vai para
 *     `failed` com motivo, não volta para a fila (caso de controle: abaixo do
 *     teto, volta). É o que impede um crash-loop invisível sobre uma poison
 *     task.
 *
 * Mais o predicado de tenant de `transitionTask` (invariante 1): antes da
 * fatia A o UPDATE escrevia só por `id`.
 *
 * Skipped sem TEST_DB_URL (`DATABASE_URL === TEST_DB_URL` é exigido porque
 * `src/db/client.ts` lê DATABASE_URL no import).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const d =
  process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL
    ? describe
    : describe.skip;

const RUN = `ob469${Date.now().toString(36)}`;
/** Teto de claims sequenciais: o claim é cross-tenant, rows alheias entram na frente. */
const MAX_CLAIMS = 60;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

d('objective_tasks — lease, fencing e reaper (#469 fatia A, migração 138)', () => {
  const tenantA = `${RUN}-ta`;
  const agentA = `${RUN}-aa`;
  const tenantB = `${RUN}-tb`;
  const agentB = `${RUN}-ab`;
  let pool: pg.Pool;

  async function ensure(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
    await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
      tenant,
    ]);
    await c.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [agent, tenant],
    );
  }

  /**
   * Claima ATÉ encontrar a tarefa deste teste. O claim é cross-tenant por
   * desenho, então specs vizinhas podem estar à frente na ordem por
   * `created_at`; as claims alheias são devolvidas para não as sequestrar.
   */
  async function claimMine(
    taskId: string,
    worker: string,
    leaseSeconds: number,
  ): Promise<string> {
    const { objectivesRepo } = await loadRepos();
    const parked: Array<{ id: string; tenant_id: string; agent_id: string; token: string }> = [];
    try {
      for (let i = 0; i < MAX_CLAIMS; i += 1) {
        const claimed = await objectivesRepo.claimNextPendingTask({
          worker_id: worker,
          lease_seconds: leaseSeconds,
        });
        if (!claimed) continue;
        if (claimed.task.id === taskId) return claimed.claim_token;
        parked.push({
          id: claimed.task.id,
          tenant_id: claimed.task.tenant_id,
          agent_id: claimed.task.agent_id,
          token: claimed.claim_token,
        });
      }
    } finally {
      for (const p of parked) {
        await objectivesRepo.transitionTask({
          tenant_id: p.tenant_id,
          agent_id: p.agent_id,
          task_id: p.id,
          status: 'pending',
          expect_claim_token: p.token,
        });
      }
    }
    throw new Error(`tarefa ${taskId} não foi claimada em ${MAX_CLAIMS} tentativas`);
  }

  async function newTask(
    tenant: string,
    agent: string,
    key: string,
  ): Promise<{ objectiveId: string; taskId: string }> {
    const { objectivesRepo } = await loadRepos();
    const objective = await objectivesRepo.create({
      tenant_id: tenant,
      agent_id: agent,
      kind: 'manual',
      title: `Objetivo ${key}`,
      params: {},
      created_by: 'op',
    });
    const task = await objectivesRepo.upsertTask({
      tenant_id: tenant,
      agent_id: agent,
      objective_id: objective.id,
      natural_key: `${RUN}-${key}`,
      title: `Tarefa ${key}`,
      payload: {},
    });
    expect(task).not.toBeNull();
    return { objectiveId: objective.id, taskId: task!.id };
  }

  async function row(taskId: string): Promise<{
    status: string;
    claimed_by: string | null;
    claim_token: string | null;
    lease_expires_at: Date | null;
    claim_attempts: number;
    error_detail: string | null;
  }> {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT status, claimed_by, claim_token, lease_expires_at, claim_attempts, error_detail
           FROM objective_tasks WHERE id = $1`,
        [taskId],
      );
      return r.rows[0];
    } finally {
      c.release();
    }
  }

  /** Empurra a lease para o passado — é o SIGKILL que não dá para simular. */
  async function expireLease(taskId: string): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE objective_tasks SET lease_expires_at = now() - interval '1 hour' WHERE id = $1`,
        [taskId],
      );
    } finally {
      c.release();
    }
  }

  async function setAttempts(taskId: string, n: number): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(`UPDATE objective_tasks SET claim_attempts = $2 WHERE id = $1`, [taskId, n]);
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensure(c, tenantA, agentA);
      await ensure(c, tenantB, agentB);
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM objective_tasks WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
      await c.query(`DELETE FROM agent_objectives WHERE tenant_id = ANY($1)`, [
        [tenantA, tenantB],
      ]);
      await c.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
      await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('o claim carimba dono, prazo e token — e incrementa claim_attempts', async () => {
    const { taskId } = await newTask(tenantA, agentA, 'claim-stamp');
    const token = await claimMine(taskId, `${RUN}-w1`, 300);

    const r = await row(taskId);
    expect(r.status).toBe('running');
    expect(r.claimed_by).toBe(`${RUN}-w1`);
    expect(r.claim_token).toBe(token);
    expect(r.lease_expires_at).not.toBeNull();
    expect(r.lease_expires_at!.getTime()).toBeGreaterThan(Date.now());
    expect(r.claim_attempts).toBe(1);
  });

  it('lease VENCIDA volta para pending; lease VIVA não é tocada (controle)', async () => {
    const { objectivesRepo } = await loadRepos();
    const morta = await newTask(tenantA, agentA, 'lease-morta');
    const viva = await newTask(tenantA, agentA, 'lease-viva');

    const tokenMorta = await claimMine(morta.taskId, `${RUN}-w-morto`, 300);
    const tokenViva = await claimMine(viva.taskId, `${RUN}-w-vivo`, 300);
    expect(tokenMorta).not.toBe(tokenViva);

    // Só a primeira perde o dono (o processo morreu).
    await expireLease(morta.taskId);

    const reaped = await objectivesRepo.reclaimExpiredTaskLeases({ limit: 50, max_attempts: 3 });
    expect(reaped.requeued).toContain(morta.taskId);
    expect(reaped.failed).not.toContain(morta.taskId);
    expect(reaped.requeued).not.toContain(viva.taskId);

    const rm = await row(morta.taskId);
    expect(rm.status).toBe('pending');
    expect(rm.claimed_by).toBeNull();
    expect(rm.claim_token).toBeNull();
    expect(rm.lease_expires_at).toBeNull();
    // O contador SOBREVIVE à reanimação: é o que dá teto ao crash-loop.
    expect(rm.claim_attempts).toBe(1);

    // CONTROLE: quem ainda tem lease viva continua exatamente onde estava.
    const rv = await row(viva.taskId);
    expect(rv.status).toBe('running');
    expect(rv.claim_token).toBe(tokenViva);
  });

  it('FENCING: o dono da lease reclamada não escreve mais; o novo dono escreve (controle)', async () => {
    const { objectivesRepo } = await loadRepos();
    const { taskId } = await newTask(tenantA, agentA, 'fencing');

    const tokenMorto = await claimMine(taskId, `${RUN}-w-a`, 300);
    await expireLease(taskId);
    await objectivesRepo.reclaimExpiredTaskLeases({ limit: 50, max_attempts: 3 });
    const tokenNovo = await claimMine(taskId, `${RUN}-w-b`, 300);
    expect(tokenNovo).not.toBe(tokenMorto);

    // O worker A "acorda" e tenta concluir a tarefa que já não é dele.
    const zumbi = await objectivesRepo.transitionTask({
      tenant_id: tenantA,
      agent_id: agentA,
      task_id: taskId,
      status: 'done',
      expect_claim_token: tokenMorto,
      outcome: { escrito_por: 'zumbi' },
    });
    expect(zumbi).toBe(false);
    expect((await row(taskId)).status).toBe('running');

    // CONTROLE: o dono atual escreve normalmente.
    const vivo = await objectivesRepo.transitionTask({
      tenant_id: tenantA,
      agent_id: agentA,
      task_id: taskId,
      status: 'done',
      expect_claim_token: tokenNovo,
      outcome: { escrito_por: 'dono' },
    });
    expect(vivo).toBe(true);

    const r = await row(taskId);
    expect(r.status).toBe('done');
    // Sair de running LIBERA o lease — token sobrevivente seria reanimável.
    expect(r.claim_token).toBeNull();
    expect(r.claimed_by).toBeNull();
    expect(r.lease_expires_at).toBeNull();
  });

  it('TETO: acima de max_attempts a tarefa vai para failed; abaixo, volta para pending (controle)', async () => {
    const { objectivesRepo } = await loadRepos();
    const poison = await newTask(tenantA, agentA, 'poison');
    const normal = await newTask(tenantA, agentA, 'normal');

    await claimMine(poison.taskId, `${RUN}-w-p`, 300);
    await claimMine(normal.taskId, `${RUN}-w-n`, 300);
    // A poison já derrubou o processo duas vezes antes desta.
    await setAttempts(poison.taskId, 3);
    await expireLease(poison.taskId);
    await expireLease(normal.taskId);

    const reaped = await objectivesRepo.reclaimExpiredTaskLeases({ limit: 50, max_attempts: 3 });
    expect(reaped.failed).toContain(poison.taskId);
    expect(reaped.requeued).toContain(normal.taskId);

    const rp = await row(poison.taskId);
    expect(rp.status).toBe('failed');
    expect(rp.error_detail).toBe('lease_expired_after_3_claims');
    expect(rp.claim_token).toBeNull();

    // CONTROLE: a tarefa comum volta para a fila e continua executável.
    const rn = await row(normal.taskId);
    expect(rn.status).toBe('pending');
    expect(rn.error_detail).toBeNull();
  });

  it('transitionTask não muta a tarefa de OUTRO tenant (invariante 1)', async () => {
    const { objectivesRepo } = await loadRepos();
    const { taskId } = await newTask(tenantA, agentA, 'tenant-pred');
    const token = await claimMine(taskId, `${RUN}-w-t`, 300);

    // O atacante conhece o id e o token, e ainda assim não escreve.
    const atacado = await objectivesRepo.transitionTask({
      tenant_id: tenantB,
      agent_id: agentB,
      task_id: taskId,
      status: 'done',
      expect_claim_token: token,
    });
    expect(atacado).toBe(false);
    expect((await row(taskId)).status).toBe('running');

    // CONTROLE: o dono legítimo escreve.
    const proprio = await objectivesRepo.transitionTask({
      tenant_id: tenantA,
      agent_id: agentA,
      task_id: taskId,
      status: 'done',
      expect_claim_token: token,
    });
    expect(proprio).toBe(true);
    expect((await row(taskId)).status).toBe('done');
  });

  it('upsertTask absorve SÓ o conflito da chave natural viva — outro índice estoura alto', async () => {
    const { objectivesRepo } = await loadRepos();
    // Token por INVOCAÇÃO (não por arquivo): o `retry: 1` do vitest reexecuta
    // o caso, e um token fixo faria a segunda tentativa tropeçar nas linhas da
    // primeira — flake disfarçado de falha.
    const marca = `ct${randomUUID().replace(/-/g, '')}`;
    const objective = await objectivesRepo.create({
      tenant_id: tenantA,
      agent_id: agentA,
      kind: 'manual',
      title: `Objetivo ${marca}`,
      params: {},
      created_by: 'op',
    });
    const base = {
      tenant_id: tenantA,
      agent_id: agentA,
      objective_id: objective.id,
      title: 'Tarefa alvo de conflito',
    };

    const primeira = await objectivesRepo.upsertTask({
      ...base,
      natural_key: `${marca}-nk1`,
      payload: {},
    });
    expect(primeira).not.toBeNull();

    // (a) O conflito PREVISTO continua absorvido: mesma (objetivo, chave
    //     natural) com a tarefa viva ⇒ null, não exceção.
    const dup = await objectivesRepo.upsertTask({
      ...base,
      natural_key: `${marca}-nk1`,
      payload: {},
    });
    expect(dup).toBeNull();

    // (b) QUALQUER outro índice único precisa ESTOURAR. Este é o cenário que
    //     a fatia B cria de verdade (índice novo sobre a tabela); com um
    //     `onConflictDoNothing()` SEM alvo, a violação viraria `null`
    //     silencioso e o chamador a leria como "já existia".
    const c = await pool.connect();
    const idx = `tmp_${marca}_uq`;
    try {
      // DDL não aceita parâmetro; o literal vem de `randomUUID` (hex puro) e o
      // predicado PARCIAL restringe o índice às linhas DESTA invocação, para
      // que specs vizinhas na mesma base não sejam atingidas pela janela.
      await c.query(
        `CREATE UNIQUE INDEX ${idx} ON objective_tasks ((payload->>'lote'))
           WHERE payload->>'lote' = '${marca}'`,
      );
      const primeiraDoLote = await objectivesRepo.upsertTask({
        ...base,
        natural_key: `${marca}-nk2`,
        payload: { lote: marca },
      });
      expect(primeiraDoLote).not.toBeNull();

      let erro: unknown;
      try {
        await objectivesRepo.upsertTask({
          ...base,
          natural_key: `${marca}-nk3`,
          payload: { lote: marca },
        });
      } catch (e) {
        erro = e;
      }
      expect(erro, 'violação de índice alheio precisa ESTOURAR, não virar null').toBeDefined();
      const causa = (erro as { cause?: { constraint?: string } }).cause;
      expect(causa?.constraint).toBe(idx);
    } finally {
      await c.query(`DROP INDEX IF EXISTS ${idx}`);
      c.release();
    }
  });

  it('o CHECK da 138 recusa `running` sem dono — a incoerência não é representável', async () => {
    const { taskId } = await newTask(tenantA, agentA, 'check-coerencia');
    const c = await pool.connect();
    try {
      await expect(
        c.query(`UPDATE objective_tasks SET status = 'running' WHERE id = $1`, [taskId]),
      ).rejects.toThrow(/objective_tasks_claim_coherence_chk/);
    } finally {
      c.release();
    }
    expect((await row(taskId)).status).toBe('pending');
  });
});
