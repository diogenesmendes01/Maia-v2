/**
 * Issue #519 — prova SEM BANCO de que o loader de readiness escopa toda leitura
 * por `(tenant_id, agent_id)`.
 *
 * A suíte de leak com Postgres cobre o comportamento de ponta a ponta, mas só
 * roda com `TEST_DB_URL`. Este teste compila o `WHERE` que o loader realmente
 * constrói, com o dialeto Pg, e afirma os predicados — então a invariante 1
 * fica provada também nas lanes sem banco. Mesmo padrão de
 * `tests/unit/agent-tool-grants-repo-scope.spec.ts` (#408).
 *
 * CONTRATO ALTERADO (review do PR #541). Este arquivo AFIRMAVA, como desenho
 * intencional, que a leitura de `agents` era filtrada só por `id` — para
 * distinguir "não existe" de "é de outro tenant". Era uma leitura cross-tenant
 * real: violava a invariante 1 do AGENTS.md e vazava EXISTÊNCIA entre tenants.
 * Agora NÃO HÁ exceção: as 8 leituras carregam o escopo, e as 7 que têm coluna
 * `agent_id` carregam o PAR completo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const captured: SQL[] = [];

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: () => chain,
    leftJoin: () => chain,
    where: (w: SQL) => {
      captured.push(w);
      return chain;
    },
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (resolve: (v: unknown) => unknown) => resolve([]),
  };
  return chain;
}

vi.mock('../../../src/db/client.js', () => ({
  db: {
    select: () => makeChain(),
    execute: () => Promise.resolve({ rows: [] }),
  },
  // `loadSchemaState` já não lê `schema_migrations` por SQL cru: ele consome o
  // veredito canônico de `src/migrations/`, que recebe o POOL. Um pool que não
  // conecta faz `getSchemaReadiness` devolver `state:'unknown'` (nunca lança,
  // fail-closed) — exatamente o que queremos aqui, onde só os predicados de
  // escopo estão sob teste.
  pool: { connect: () => Promise.reject(new Error('sem banco neste teste')) },
  withTx: vi.fn(),
  pgErrorCode: () => undefined,
}));

function compile(where: SQL): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(where);
  return { sql: q.sql, params: q.params as unknown[] };
}

beforeEach(() => {
  captured.length = 0;
});

describe('loadReadinessFactsFromDb — predicados de escopo', () => {
  it('TODA leitura carrega o escopo — inclusive a de `agents`', async () => {
    const { loadReadinessFactsFromDb } = await import(
      '../../../src/onboarding/readiness-facts.js'
    );
    await loadReadinessFactsFromDb({ tenant_id: 'tA', agent_id: 'agA' });

    // 8 leituras: tenants, agents, profile, grant, roles, channels, policies, drift.
    expect(captured.length).toBe(8);

    const compiled = captured.map(compile);
    const scoped = compiled.filter(
      (c) => c.params.includes('tA') && c.params.includes('agA'),
    );
    // 7 das 8 ligam os DOIS parâmetros de escopo: agents, profile, grant,
    // roles, channels, policies, drift. Antes eram 6 — `agents` era a exceção
    // que vazava.
    expect(scoped.length).toBe(7);
    for (const c of scoped) {
      expect(c.sql).toMatch(/tenant_id/);
      // `agents` identifica o agente pela PK `id`; as demais por `agent_id`.
      expect(c.sql).toMatch(/agent_id|"agents"\."id"/);
    }

    // A leitura de `tenants` é por id do tenant (é a própria linha do tenant).
    const tenantRead = compiled.find((c) => c.sql.includes('"tenants"."id"'));
    expect(tenantRead?.params).toContain('tA');
  });

  it('a leitura de `agents` carrega `tenant_id` — sem ele, existência vaza entre tenants', async () => {
    const { loadReadinessFactsFromDb } = await import(
      '../../../src/onboarding/readiness-facts.js'
    );
    await loadReadinessFactsFromDb({ tenant_id: 'tA', agent_id: 'agA' });

    const agentRead = captured
      .map(compile)
      .find((c) => c.sql.includes('"agents"."id"'));
    expect(agentRead, 'nenhuma leitura de `agents` foi capturada').toBeDefined();
    // O predicado precisa citar as DUAS colunas e ligar os DOIS parâmetros.
    expect(agentRead!.sql).toMatch(/"agents"\."id"/);
    expect(agentRead!.sql).toMatch(/"agents"\."tenant_id"/);
    expect(agentRead!.params).toEqual(['agA', 'tA']);
  });

  it('nenhum predicado vaza um escopo diferente do requisitado', async () => {
    const { loadReadinessFactsFromDb } = await import(
      '../../../src/onboarding/readiness-facts.js'
    );
    await loadReadinessFactsFromDb({ tenant_id: 'tenant-x', agent_id: 'agent-x' });
    for (const where of captured) {
      const { params } = compile(where);
      for (const p of params) {
        if (typeof p !== 'string') continue;
        // Os únicos valores de escopo que podem aparecer são os pedidos.
        // Constantes de domínio ('active', 'critical') são aceitas.
        expect(['tenant-x', 'agent-x', 'active', 'critical']).toContain(p);
      }
    }
  });
});
