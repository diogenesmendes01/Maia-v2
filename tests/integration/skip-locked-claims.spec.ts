/**
 * Issue #481 item 2 — prova de concorrência dos claims `FOR UPDATE SKIP
 * LOCKED` contra Postgres REAL:
 *
 *   - `playgroundRepo.claimNextQueuedTurn()`   (087 / issue #464)
 *   - `objectivesRepo.claimNextPendingTask()`  (088 / issue #469)
 *
 * Até aqui a concorrência estava coberta por DESENHO (o SQL está no repo),
 * não por teste. O que quebraria em produção — duas réplicas do worker
 * processando o MESMO turno/tarefa (resposta duplicada, cobrança duplicada) —
 * só aparece com claims paralelos de verdade.
 *
 * Invariante provada: sob N claims simultâneos, cada row é entregue a NO
 * MÁXIMO um chamador. Uma regressão que troque o claim atômico por
 * SELECT-depois-UPDATE devolve a mesma row duas vezes e derruba estes testes.
 *
 * Robustez a rows alheias: os claims dos workers são CROSS-TENANT por
 * desenho (a réplica re-deriva o tenant da row), então uma spec vizinha
 * rodando em paralelo pode deixar turnos/tarefas pendentes na mesma base. Os
 * testes por isso (a) contam duplicatas sobre TODAS as rows entregues — o
 * invariante real — e (b) fazem rounds até drenar as PRÓPRIAS rows.
 *
 * Skipped sem TEST_DB_URL (`DATABASE_URL === TEST_DB_URL` é exigido porque
 * `src/db/client.ts` lê DATABASE_URL no import).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const d =
  process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL
    ? describe
    : describe.skip;

/** Claims simultâneos por round. Abaixo do `max: 10` do pool de src/db/client. */
const PARALLEL = 5;
/** Rows enfileiradas pelo teste. */
const QUEUED = 5;
/** Teto de rounds — protege contra loop infinito se algo travar. */
const MAX_ROUNDS = 10;
/** Teto de claims sequenciais (laços que não usam `drain`). */
const MAX_CLAIMS = 40;

const RUN = `sl481${Date.now().toString(36)}`;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

/**
 * Roda rounds de `PARALLEL` claims até que todos os `mineIds` tenham sido
 * entregues (ou o teto de rounds estourar). Devolve TODOS os ids entregues,
 * na ordem — duplicatas incluídas, porque é justamente o que se quer provar
 * que não existe.
 */
async function drain(
  claim: () => Promise<string | null>,
  mineIds: Set<string>,
): Promise<{ delivered: string[]; rounds: number }> {
  const delivered: string[] = [];
  const remaining = new Set(mineIds);
  let rounds = 0;
  while (remaining.size > 0 && rounds < MAX_ROUNDS) {
    rounds += 1;
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => claim()),
    );
    for (const id of results) {
      if (id === null) continue;
      delivered.push(id);
      remaining.delete(id);
    }
  }
  return { delivered, rounds };
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

d('SKIP LOCKED — playgroundRepo.claimNextQueuedTurn (#481)', () => {
  const tenant = `${RUN}-pg`;
  const agent = `${RUN}-pg-agent`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, tenant, agent);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM playground_turns WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM playground_sessions WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('entrega cada turno enfileirado a NO MÁXIMO um worker sob claims paralelos', async () => {
    const { playgroundRepo } = await loadRepos();
    const session = await playgroundRepo.createSession({
      tenant_id: tenant,
      agent_id: agent,
      profile_version_id: null,
      created_by: 'op',
    });
    const mine = new Set<string>();
    for (let i = 0; i < QUEUED; i += 1) {
      const turn = await playgroundRepo.enqueueUserTurn({
        tenant_id: tenant,
        agent_id: agent,
        session_id: session.id,
        content: `mensagem ${i}`,
      });
      mine.add(turn.id);
    }

    const { delivered } = await drain(async () => {
      const claimed = await playgroundRepo.claimNextQueuedTurn();
      return claimed?.turn.id ?? null;
    }, mine);

    // (1) O invariante: nenhuma row entregue duas vezes.
    expect(duplicates(delivered)).toEqual([]);
    // (2) Todos os turnos do teste foram consumidos.
    for (const id of mine) expect(delivered).toContain(id);

    // (3) Estado persistido: 'running', nenhum 'queued' sobrando.
    const c = await pool.connect();
    try {
      const rows = await c.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM playground_turns
          WHERE session_id = $1 GROUP BY status`,
        [session.id],
      );
      const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.count)]));
      expect(byStatus.running).toBe(QUEUED);
      expect(byStatus.queued ?? 0).toBe(0);
    } finally {
      c.release();
    }
  });

  it('o turno reivindicado já sai como `running` (claim e transição são atômicos)', async () => {
    const { playgroundRepo } = await loadRepos();
    const session = await playgroundRepo.createSession({
      tenant_id: tenant,
      agent_id: agent,
      profile_version_id: null,
      created_by: 'op',
    });
    const turn = await playgroundRepo.enqueueUserTurn({
      tenant_id: tenant,
      agent_id: agent,
      session_id: session.id,
      content: 'turno único',
    });
    const mine = new Set([turn.id]);
    const { delivered } = await drain(async () => {
      const claimed = await playgroundRepo.claimNextQueuedTurn();
      // A row devolvida pelo claim já reflete a transição — nunca 'queued'.
      if (claimed) expect(claimed.turn.status).toBe('running');
      return claimed?.turn.id ?? null;
    }, mine);
    expect(duplicates(delivered)).toEqual([]);
    expect(delivered).toContain(turn.id);
  });
});

d('SKIP LOCKED — objectivesRepo.claimNextPendingTask (#481)', () => {
  const tenant = `${RUN}-ob`;
  const agent = `${RUN}-ob-agent`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, tenant, agent);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM objective_tasks WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM agent_objectives WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('entrega cada tarefa pendente a NO MÁXIMO um worker sob claims paralelos', async () => {
    const { objectivesRepo } = await loadRepos();
    const objective = await objectivesRepo.create({
      tenant_id: tenant,
      agent_id: agent,
      kind: 'manual',
      title: 'Objetivo concorrente',
      params: {},
      created_by: 'op',
    });
    const mine = new Set<string>();
    for (let i = 0; i < QUEUED; i += 1) {
      const task = await objectivesRepo.upsertTask({
        tenant_id: tenant,
        agent_id: agent,
        objective_id: objective.id,
        natural_key: `nk-${i}`,
        title: `Tarefa ${i}`,
        payload: {},
      });
      expect(task).not.toBeNull();
      mine.add(task!.id);
    }

    const { delivered } = await drain(async () => {
      const claimed = await objectivesRepo.claimNextPendingTask();
      return claimed?.task.id ?? null;
    }, mine);

    expect(duplicates(delivered)).toEqual([]);
    for (const id of mine) expect(delivered).toContain(id);

    const c = await pool.connect();
    try {
      const rows = await c.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM objective_tasks
          WHERE objective_id = $1 GROUP BY status`,
        [objective.id],
      );
      const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.count)]));
      expect(byStatus.running).toBe(QUEUED);
      expect(byStatus.pending ?? 0).toBe(0);
    } finally {
      c.release();
    }
  });

  it('tarefa de objetivo PAUSADO é cancelada dentro do claim, nunca executada (guardrail 4)', async () => {
    const { objectivesRepo } = await loadRepos();
    const objective = await objectivesRepo.create({
      tenant_id: tenant,
      agent_id: agent,
      kind: 'manual',
      title: 'Objetivo que será pausado',
      params: {},
      created_by: 'op',
    });
    const task = await objectivesRepo.upsertTask({
      tenant_id: tenant,
      agent_id: agent,
      objective_id: objective.id,
      natural_key: 'nk-pausada',
      title: 'Tarefa órfã',
      payload: {},
    });
    expect(task).not.toBeNull();
    await objectivesRepo.setStatus({
      tenant_id: tenant,
      agent_id: agent,
      objective_id: objective.id,
      status: 'paused',
    });

    // O claim consome a row (cancelando-a) e devolve null — a réplica NUNCA
    // recebe a tarefa para executar. O laço é sequencial e generoso porque o
    // claim é cross-tenant: rows pendentes de specs vizinhas podem estar à
    // frente na ordem por `created_at` e consomem iterações.
    let sawTask = false;
    for (let i = 0; i < MAX_CLAIMS; i += 1) {
      const claimed = await objectivesRepo.claimNextPendingTask();
      if (claimed?.task.id === task!.id) sawTask = true;
      const row = await objectivesRepo.findTaskById({
        tenant_id: tenant,
        agent_id: agent,
        task_id: task!.id,
      });
      if (row?.status === 'cancelled') break;
    }
    expect(sawTask).toBe(false);

    const final = await objectivesRepo.findTaskById({
      tenant_id: tenant,
      agent_id: agent,
      task_id: task!.id,
    });
    expect(final?.status).toBe('cancelled');
    expect(final?.error_detail).toBe('objective_paused');
  });
});
