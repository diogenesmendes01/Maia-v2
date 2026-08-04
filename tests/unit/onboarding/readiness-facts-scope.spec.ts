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
 * A única leitura DELIBERADAMENTE não filtrada por tenant é a de `agents`: o
 * avaliador precisa distinguir "o agente não existe" de "o agente existe mas é
 * de outro tenant" (check `agent_belongs_to_tenant`). O teste trava esse
 * contrato explicitamente para que a exceção não vire regressão silenciosa.
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
    // `loadSchemaState` lê `schema_migrations` por SQL cru.
    execute: () => Promise.resolve({ rows: [] }),
  },
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
  it('toda leitura carrega o par requisitado, exceto a de `agents` (por desenho)', async () => {
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
    // 6 das 8 provam o PAR completo: profile, grant, roles, channels, policies, drift.
    expect(scoped.length).toBe(6);
    for (const c of scoped) {
      expect(c.sql).toMatch(/tenant_id/);
      expect(c.sql).toMatch(/agent_id/);
    }

    // A leitura de `tenants` é por id do tenant (é a própria linha do tenant).
    const tenantRead = compiled.find((c) => c.sql.includes('"tenants"."id"'));
    expect(tenantRead?.params).toContain('tA');

    // A leitura de `agents` é por id do agente APENAS — a exceção documentada.
    const agentRead = compiled.find((c) => c.sql.includes('"agents"."id"'));
    expect(agentRead?.params).toEqual(['agA']);
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
