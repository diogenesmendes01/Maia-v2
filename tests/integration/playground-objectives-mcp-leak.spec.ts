/**
 * Issue #481 item 1 — suíte de vazamento cross-tenant das tabelas da rodada
 * 2026-06-10, que ficaram fora do `npm run test:leak`:
 *
 *   - `playground_sessions` / `playground_turns`   (migração 087, issue #464)
 *   - `agent_objectives`   / `objective_tasks`     (migração 088, issue #469)
 *   - `mcp_servers`        / `mcp_server_tools`    (migração 089, issue #478)
 *
 * As specs exigem isolamento (aceite §6 de cada uma) e os repos escopam por
 * tenant — esta suíte é o guard-rail que impede uma regressão silenciosa
 * (um `and(...)` a menos dentro de um método).
 *
 * Estrutura, espelhando `agent-tool-grants-leak.spec.ts`:
 *   - bloco RAW SQL: prova o filtro na camada de query (defesa em
 *     profundidade), dentro de BEGIN/ROLLBACK;
 *   - blocos REPO: exercitam o CÓDIGO REAL dos repos — só rodam quando
 *     DATABASE_URL === TEST_DB_URL, porque `src/db/client.ts` lê DATABASE_URL
 *     no import. Sem transação (os repos usam o pool global e não enxergariam
 *     rows não commitadas), então cada bloco cria tenants próprios com sufixo
 *     único por execução e os apaga no `afterAll` em ordem FK-safe. Cada
 *     bloco tem o SEU pool (o `afterAll` de um bloco encerraria o pool
 *     compartilhado dos demais).
 *
 * Invariantes cobertas: #1 (todo boundary com estado escopa por tenant_id +
 * agent_id) e #2 (fail-closed — id de outro tenant NUNCA resolve).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const dRaw = process.env.TEST_DB_URL ? describe : describe.skip;
const dRepo =
  process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL
    ? describe
    : describe.skip;

/** Sufixo único por execução — evita colisão com rows de runs anteriores. */
const RUN = `l481${Date.now().toString(36)}`;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env.TEST_DB_URL });
}

async function ensureTenantAgent(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  // tenants.nome / agents.nome são NOT NULL. Sem `.catch()`: dentro de um
  // BEGIN um erro engolido ainda ABORTA a transação (Postgres 25P02).
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * RAW SQL — o filtro na camada de query
 * ═════════════════════════════════════════════════════════════════════════ */

dRaw('leak 087/088/089 — raw SQL (#481)', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = newPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('playground_sessions/turns: consulta escopada nunca devolve outro tenant', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tPgA', 'agPgA');
      await ensureTenantAgent(c, 'tPgB', 'agPgB');
      const sA = await c.query<{ id: string }>(
        `INSERT INTO playground_sessions(tenant_id, agent_id, created_by)
         VALUES ('tPgA', 'agPgA', 'op-a') RETURNING id`,
      );
      const sB = await c.query<{ id: string }>(
        `INSERT INTO playground_sessions(tenant_id, agent_id, created_by)
         VALUES ('tPgB', 'agPgB', 'op-b') RETURNING id`,
      );
      await c.query(
        `INSERT INTO playground_turns(session_id, tenant_id, agent_id, role, content)
         VALUES ($1, 'tPgA', 'agPgA', 'user', 'segredo A'),
                ($2, 'tPgB', 'agPgB', 'user', 'segredo B')`,
        [sA.rows[0]!.id, sB.rows[0]!.id],
      );

      const sessions = await c.query<{ id: string }>(
        `SELECT id FROM playground_sessions WHERE tenant_id = $1 AND agent_id = $2`,
        ['tPgA', 'agPgA'],
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]!.id).toBe(sA.rows[0]!.id);

      // O id da sessão SOZINHO não pode ser chave de acesso: com o tenant
      // errado, a query não devolve nada.
      const crossed = await c.query(
        `SELECT id FROM playground_turns
          WHERE session_id = $1 AND tenant_id = $2 AND agent_id = $3`,
        [sA.rows[0]!.id, 'tPgB', 'agPgB'],
      );
      expect(crossed.rows).toHaveLength(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('agent_objectives/objective_tasks: consulta escopada nunca devolve outro tenant', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tObA', 'agObA');
      await ensureTenantAgent(c, 'tObB', 'agObB');
      const oA = await c.query<{ id: string }>(
        `INSERT INTO agent_objectives(tenant_id, agent_id, kind, title, created_by)
         VALUES ('tObA', 'agObA', 'manual', 'Objetivo A', 'op-a') RETURNING id`,
      );
      const oB = await c.query<{ id: string }>(
        `INSERT INTO agent_objectives(tenant_id, agent_id, kind, title, created_by)
         VALUES ('tObB', 'agObB', 'manual', 'Objetivo B', 'op-b') RETURNING id`,
      );
      await c.query(
        `INSERT INTO objective_tasks(objective_id, tenant_id, agent_id, natural_key, title)
         VALUES ($1, 'tObA', 'agObA', 'k-a', 'Tarefa A'),
                ($2, 'tObB', 'agObB', 'k-b', 'Tarefa B')`,
        [oA.rows[0]!.id, oB.rows[0]!.id],
      );

      const objs = await c.query<{ id: string }>(
        `SELECT id FROM agent_objectives WHERE tenant_id = $1 AND agent_id = $2`,
        ['tObA', 'agObA'],
      );
      expect(objs.rows).toHaveLength(1);
      expect(objs.rows[0]!.id).toBe(oA.rows[0]!.id);

      const tasks = await c.query<{ title: string }>(
        `SELECT title FROM objective_tasks WHERE tenant_id = $1 AND agent_id = $2`,
        ['tObA', 'agObA'],
      );
      expect(tasks.rows.map((r) => r.title)).toEqual(['Tarefa A']);

      // Objetivo de outro tenant + tenant próprio ⇒ zero rows (nem o
      // objective_id sozinho abre a porta).
      const crossed = await c.query(
        `SELECT id FROM objective_tasks WHERE objective_id = $1 AND tenant_id = $2`,
        [oB.rows[0]!.id, 'tObA'],
      );
      expect(crossed.rows).toHaveLength(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('mcp_servers/mcp_server_tools: consulta escopada nunca devolve outro tenant', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureTenantAgent(c, 'tMcA', 'agMcA');
      await ensureTenantAgent(c, 'tMcB', 'agMcB');
      // MESMO `name` nos dois tenants — o UNIQUE é (tenant_id, name), então
      // homônimos são legítimos e é exatamente aí que um filtro faltante
      // vazaria.
      const svA = await c.query<{ id: string }>(
        `INSERT INTO mcp_servers(tenant_id, name, url, created_by)
         VALUES ('tMcA', 'erp', 'https://erp-a.example.com/mcp', 'op-a') RETURNING id`,
      );
      const svB = await c.query<{ id: string }>(
        `INSERT INTO mcp_servers(tenant_id, name, url, created_by)
         VALUES ('tMcB', 'erp', 'https://erp-b.example.com/mcp', 'op-b') RETURNING id`,
      );
      await c.query(
        `INSERT INTO mcp_server_tools(server_id, tenant_id, tool_name, schema_hash)
         VALUES ($1, 'tMcA', 'list_orders', 'hash-a'),
                ($2, 'tMcB', 'list_orders', 'hash-b')`,
        [svA.rows[0]!.id, svB.rows[0]!.id],
      );

      const servers = await c.query<{ id: string; url: string }>(
        `SELECT id, url FROM mcp_servers WHERE tenant_id = $1 AND name = $2`,
        ['tMcA', 'erp'],
      );
      expect(servers.rows).toHaveLength(1);
      expect(servers.rows[0]!.url).toContain('erp-a');

      const crossed = await c.query(
        `SELECT id FROM mcp_server_tools WHERE server_id = $1 AND tenant_id = $2`,
        [svB.rows[0]!.id, 'tMcA'],
      );
      expect(crossed.rows).toHaveLength(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * REPOS — o código real
 * ═════════════════════════════════════════════════════════════════════════ */

dRepo('leak 087 — playgroundRepo (#481)', () => {
  const tA = `${RUN}-pg-a`;
  const tB = `${RUN}-pg-b`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = newPool();
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, tA, `${tA}-agent`);
      await ensureTenantAgent(c, tB, `${tB}-agent`);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM playground_turns WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM playground_sessions WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tA, tB]]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('findSession: id de outro tenant/agent devolve null (fail-closed)', async () => {
    const { playgroundRepo } = await loadRepos();
    const session = await playgroundRepo.createSession({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      profile_version_id: null,
      created_by: 'op-a',
    });
    expect(
      await playgroundRepo.findSession({
        tenant_id: tA,
        agent_id: `${tA}-agent`,
        session_id: session.id,
      }),
    ).not.toBeNull();
    // Tenant errado.
    expect(
      await playgroundRepo.findSession({
        tenant_id: tB,
        agent_id: `${tB}-agent`,
        session_id: session.id,
      }),
    ).toBeNull();
    // Tenant certo, AGENTE errado — invariante #1 é (tenant, agent).
    expect(
      await playgroundRepo.findSession({
        tenant_id: tA,
        agent_id: `${tB}-agent`,
        session_id: session.id,
      }),
    ).toBeNull();
  });

  it('listTurns: conteúdo de uma sessão nunca aparece sob outro tenant', async () => {
    const { playgroundRepo } = await loadRepos();
    const session = await playgroundRepo.createSession({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      profile_version_id: null,
      created_by: 'op-a',
    });
    await playgroundRepo.enqueueUserTurn({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      session_id: session.id,
      content: 'saldo confidencial do tenant A',
    });

    const own = await playgroundRepo.listTurns({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      session_id: session.id,
    });
    expect(own).toHaveLength(1);
    expect(own[0]!.content).toContain('confidencial');

    const crossed = await playgroundRepo.listTurns({
      tenant_id: tB,
      agent_id: `${tB}-agent`,
      session_id: session.id,
    });
    expect(crossed).toEqual([]);
  });
});

dRepo('leak 088 — objectivesRepo (#481)', () => {
  const tA = `${RUN}-ob-a`;
  const tB = `${RUN}-ob-b`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = newPool();
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, tA, `${tA}-agent`);
      await ensureTenantAgent(c, tB, `${tB}-agent`);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM objective_tasks WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM agent_objectives WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tA, tB]]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('findById / listByAgent: objetivo de outro tenant é invisível', async () => {
    const { objectivesRepo } = await loadRepos();
    const objA = await objectivesRepo.create({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      kind: 'manual',
      title: 'Cobrar inadimplentes A',
      params: {},
      created_by: 'op-a',
    });
    await objectivesRepo.create({
      tenant_id: tB,
      agent_id: `${tB}-agent`,
      kind: 'manual',
      title: 'Cobrar inadimplentes B',
      params: {},
      created_by: 'op-b',
    });

    expect(
      await objectivesRepo.findById({
        tenant_id: tB,
        agent_id: `${tB}-agent`,
        objective_id: objA.id,
      }),
    ).toBeNull();

    const listB = await objectivesRepo.listByAgent({
      tenant_id: tB,
      agent_id: `${tB}-agent`,
    });
    expect(listB.map((o) => o.title)).toEqual(['Cobrar inadimplentes B']);
  });

  it('setStatus: escrita cross-tenant não muta nada (fail-closed)', async () => {
    const { objectivesRepo } = await loadRepos();
    const objA = await objectivesRepo.create({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      kind: 'manual',
      title: 'Objetivo protegido',
      params: {},
      created_by: 'op-a',
    });

    const attacked = await objectivesRepo.setStatus({
      tenant_id: tB,
      agent_id: `${tB}-agent`,
      objective_id: objA.id,
      status: 'archived',
    });
    expect(attacked).toBeNull();

    const still = await objectivesRepo.findById({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      objective_id: objA.id,
    });
    expect(still?.status).toBe('active');
  });

  it('listTasks / findTaskById / listExceptionsByTenant escopam por tenant', async () => {
    const { objectivesRepo } = await loadRepos();
    const objA = await objectivesRepo.create({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      kind: 'manual',
      title: 'Objetivo com tarefas',
      params: {},
      created_by: 'op-a',
    });
    const task = await objectivesRepo.upsertTask({
      tenant_id: tA,
      agent_id: `${tA}-agent`,
      objective_id: objA.id,
      natural_key: 'nk-1',
      title: 'Tarefa confidencial A',
      payload: { valor: 1234 },
    });
    expect(task).not.toBeNull();
    await objectivesRepo.transitionTask({ task_id: task!.id, status: 'waiting_human' });

    expect(
      await objectivesRepo.findTaskById({
        tenant_id: tB,
        agent_id: `${tB}-agent`,
        task_id: task!.id,
      }),
    ).toBeNull();

    expect(await objectivesRepo.listTasks({ tenant_id: tB, agent_id: `${tB}-agent` })).toEqual([]);

    // Fila de exceções do dashboard — é por TENANT; a de B não pode conter A.
    const exceptionsB = await objectivesRepo.listExceptionsByTenant({ tenant_id: tB });
    expect(exceptionsB.every((t) => t.tenant_id === tB)).toBe(true);
    expect(exceptionsB.some((t) => t.id === task!.id)).toBe(false);

    const exceptionsA = await objectivesRepo.listExceptionsByTenant({ tenant_id: tA });
    expect(exceptionsA.map((t) => t.id)).toContain(task!.id);
  });
});

dRepo('leak 089 — mcpServersRepo / mcpServerToolsRepo (#481)', () => {
  const tA = `${RUN}-mc-a`;
  const tB = `${RUN}-mc-b`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = newPool();
    const c = await pool.connect();
    try {
      await ensureTenantAgent(c, tA, `${tA}-agent`);
      await ensureTenantAgent(c, tB, `${tB}-agent`);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM mcp_server_tools WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM mcp_servers WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [[tA, tB]]);
      await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tA, tB]]);
    } finally {
      c.release();
      await pool.end().catch(() => undefined);
    }
  });

  /**
   * Cria um server HOMÔNIMO nos dois tenants (o UNIQUE é `(tenant_id, name)`)
   * com uma tool aprovada + read-only em cada. `name` varia por teste porque
   * este bloco não roda em transação.
   */
  async function seedBothTenants(name: string): Promise<{
    serverA: { id: string };
    serverB: { id: string };
    toolAId: string;
  }> {
    const { mcpServersRepo, mcpServerToolsRepo, mcpSchemaHash } = await loadRepos();
    const serverA = await mcpServersRepo.create({
      tenant_id: tA,
      name,
      url: 'https://erp-a.example.com/mcp',
      auth_secret_ref: null,
      created_by: 'op-a',
    });
    const serverB = await mcpServersRepo.create({
      tenant_id: tB,
      name,
      url: 'https://erp-b.example.com/mcp',
      auth_secret_ref: null,
      created_by: 'op-b',
    });
    const schema = { type: 'object' };
    for (const [tenant, server] of [
      [tA, serverA],
      [tB, serverB],
    ] as const) {
      await mcpServerToolsRepo.upsertDiscovered({
        tenant_id: tenant,
        server_id: server.id,
        tool_name: 'list_orders',
        description: `pedidos de ${tenant}`,
        input_schema: schema,
        schema_hash: mcpSchemaHash(schema),
      });
    }
    const toolsA = await mcpServerToolsRepo.listByServer({
      tenant_id: tA,
      server_id: serverA.id,
    });
    const toolsB = await mcpServerToolsRepo.listByServer({
      tenant_id: tB,
      server_id: serverB.id,
    });
    for (const [tenant, tool] of [
      [tA, toolsA[0]!],
      [tB, toolsB[0]!],
    ] as const) {
      await mcpServerToolsRepo.decide({
        tenant_id: tenant,
        tool_id: tool.id,
        decision: 'approved',
        is_read_only: true,
        risk_class: 'low',
        actor_id: 'owner',
        comment: 'aprovada para o teste de vazamento',
      });
    }
    return { serverA, serverB, toolAId: toolsA[0]!.id };
  }

  it('findById / findByName / listByTenant: homônimo de outro tenant não vaza', async () => {
    const { mcpServersRepo } = await loadRepos();
    const { serverA } = await seedBothTenants('erp-find');

    expect(await mcpServersRepo.findById({ tenant_id: tB, server_id: serverA.id })).toBeNull();

    // Mesmo NOME nos dois tenants: cada um enxerga só a própria URL.
    const byNameB = await mcpServersRepo.findByName({ tenant_id: tB, name: 'erp-find' });
    expect(byNameB?.url).toContain('erp-b');

    const listB = await mcpServersRepo.listByTenant(tB);
    expect(listB.every((s) => s.tenant_id === tB)).toBe(true);
    expect(listB.some((s) => s.id === serverA.id)).toBe(false);
  });

  it('setStatus / requestOp / decide: escritas cross-tenant não mutam nada', async () => {
    const { mcpServersRepo, mcpServerToolsRepo } = await loadRepos();
    const { serverA, toolAId } = await seedBothTenants('erp-write');

    expect(
      await mcpServersRepo.setStatus({
        tenant_id: tB,
        server_id: serverA.id,
        status: 'disabled',
      }),
    ).toBeNull();
    expect(
      await mcpServersRepo.requestOp({ tenant_id: tB, server_id: serverA.id, op: 'sync' }),
    ).toBe(false);
    expect(
      await mcpServerToolsRepo.decide({
        tenant_id: tB,
        tool_id: toolAId,
        decision: 'rejected',
        is_read_only: false,
        risk_class: 'critical',
        actor_id: 'atacante',
        comment: 'tentativa de rebaixar a tool de outro tenant',
      }),
    ).toBeNull();

    // Estado de A intacto.
    const stillA = await mcpServersRepo.findById({ tenant_id: tA, server_id: serverA.id });
    expect(stillA?.status).toBe('active');
    const toolsA = await mcpServerToolsRepo.listByServer({
      tenant_id: tA,
      server_id: serverA.id,
    });
    expect(toolsA[0]!.status).toBe('approved');
  });

  it('listExecutable / listByServer: a superfície do bridge é por tenant', async () => {
    const { mcpServerToolsRepo } = await loadRepos();
    const { serverA } = await seedBothTenants('erp-exec');

    const execB = await mcpServerToolsRepo.listExecutable({ tenant_id: tB });
    expect(execB.length).toBeGreaterThan(0);
    expect(execB.every((t) => t.tenant_id === tB)).toBe(true);
    expect(execB.every((t) => t.server_url.includes('erp-b'))).toBe(true);

    // Server de A lido com o tenant de B ⇒ nada (o id sozinho não abre).
    expect(await mcpServerToolsRepo.listByServer({ tenant_id: tB, server_id: serverA.id })).toEqual(
      [],
    );
  });
});
