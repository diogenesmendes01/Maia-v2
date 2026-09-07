/**
 * Issue #738 — `resolveScope` contra Postgres real: 501 profiles DISTINTOS e
 * isolamento entre tenants.
 *
 * O defeito morava em SQL — `profilesRepo.byIds(ids, limit = 500)`, o `LIMIT`
 * que cortava a leitura de perfis por ordem de id acima de 500 profiles
 * distintos e fazia `resolveScope` descartar grants reais em silêncio —, então
 * um repositório mockado não o teria. Aqui a leitura é a de produção
 * (`profilesRepo.forAuthorization`, sem `LIMIT`), o banco é real e as duas
 * propriedades que o dono exigiu são afirmadas juntas:
 *
 *  1. **501 profiles distintos ⇒ 501 grants resolvidos**, em exatamente DUAS
 *     round-trips (`forPessoa` + `forAuthorization`), contadas pelo contador de
 *     produção (`src/db/query-counter.ts`) — a correção não pode comprar
 *     correção com um JOIN (#693, fechada) nem com paginação.
 *  2. **Isolamento.** `permission_profiles.id` é PK GLOBAL (TEXT), então dois
 *     tenants não podem ter o MESMO id; o que podem ter é o mesmo NOME — e é
 *     isso que o segundo tenant semeia: 501 profiles homônimos, 501 permissões
 *     para uma pessoa dele, e ainda uma permissão do tenant A apontando para um
 *     profile do tenant B. Nada de B pode entrar no escopo de A, e vice-versa.
 *
 * Skipped without TEST_DB_URL, como as demais specs de integração. As linhas são
 * commitadas (os repositórios usam o pool global e não veem transação aberta) e
 * removidas por tenant no `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const A = { tenant_id: 'i738-tA', agent_id: 'i738-agA' };
const B = { tenant_id: 'i738-tB', agent_id: 'i738-agB' };

/** Um além do `LIMIT 500` que a leitura antiga tinha. */
const PROFILE_COUNT = 501;

type Semeado = {
  pessoa_id: string;
  entidade_ids: string[];
  profile_ids: string[];
  /** Só no tenant A: a entidade cuja permissão aponta para um profile de B. */
  entidade_estrangeira?: string;
};

let pool: pg.Pool;
let semeadoA: Semeado;
let semeadoB: Semeado;

/**
 * Semeia um tenant inteiro: 501 profiles (ids com o tenant no nome, NOMES
 * iguais entre tenants), 501 entidades, uma pessoa não-dona e 501 permissões,
 * a i-ésima entidade apontando para o i-ésimo profile.
 */
async function semearTenant(
  c: pg.PoolClient,
  scope: { tenant_id: string; agent_id: string },
  telefone: string,
): Promise<Semeado> {
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    scope.tenant_id,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [scope.agent_id, scope.tenant_id],
  );

  const profiles = await c.query<{ id: string }>(
    `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
     SELECT $1 || '-prof-' || lpad(g::text, 4, '0'), $1, $2,
            'i738-prof-' || lpad(g::text, 4, '0'),
            ARRAY['registrar_transacao'], 100
     FROM generate_series(1, $3) g
     ORDER BY g
     RETURNING id`,
    [scope.tenant_id, scope.agent_id, PROFILE_COUNT],
  );
  const profile_ids = profiles.rows.map((r) => r.id);

  const entidades = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     SELECT $1, $2, $1 || '-ent-' || lpad(g::text, 4, '0'), 'pj'
     FROM generate_series(1, $3) g
     ORDER BY g
     RETURNING id`,
    [scope.tenant_id, scope.agent_id, PROFILE_COUNT],
  );
  const entidade_ids = entidades.rows.map((r) => r.id);

  // 'funcionario' (e não dono/co_dono): o acesso desta pessoa vem TODO das
  // permissões — ver a nota sobre `pessoas.tipo` × `permissoes.papel` em
  // `turn-context-batch-repos.spec.ts`.
  const pessoa = await c.query<{ id: string }>(
    `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'i738-pessoa', $3, 'funcionario', 'ativa') RETURNING id`,
    [scope.tenant_id, scope.agent_id, telefone],
  );
  const pessoa_id = pessoa.rows[0]!.id;

  await c.query(
    `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
     SELECT $1, $2, $3, u.eid, 'operador', u.pid, 'ativa'
     FROM unnest($4::uuid[], $5::text[]) AS u(eid, pid)`,
    [scope.tenant_id, scope.agent_id, pessoa_id, entidade_ids, profile_ids],
  );

  return { pessoa_id, entidade_ids, profile_ids };
}

d('#738 — resolveScope com 501 profiles distintos, em Postgres real', () => {
  const permissions = moduloDeProducao(() => import('@/governance/permissions.js'));
  const repos = moduloDeProducao(() => import('@/db/repositories.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    const c = await pool.connect();
    try {
      semeadoA = await semearTenant(c, A, '+5511738000001');
      semeadoB = await semearTenant(c, B, '+5511738000002');

      // A 502ª permissão de A aponta para um profile de B — a forma exata de
      // um vazamento: o id existe, só que em outro tenant.
      const ent = await c.query<{ id: string }>(
        `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
         VALUES ($1, $2, 'i738-tA-ent-estrangeira', 'pj') RETURNING id`,
        [A.tenant_id, A.agent_id],
      );
      semeadoA.entidade_estrangeira = ent.rows[0]!.id;
      await c.query(
        `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
         VALUES ($1, $2, $3, $4, 'operador', $5, 'ativa')`,
        [A.tenant_id, A.agent_id, semeadoA.pessoa_id, ent.rows[0]!.id, semeadoB.profile_ids[0]],
      );
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    const tenants = [A.tenant_id, B.tenant_id];
    try {
      await c.query(`DELETE FROM permissoes WHERE tenant_id = ANY($1)`, [tenants]);
      await c.query(`DELETE FROM pessoas WHERE tenant_id = ANY($1)`, [tenants]);
      await c.query(`DELETE FROM entidades WHERE tenant_id = ANY($1)`, [tenants]);
      await c.query(`DELETE FROM permission_profiles WHERE tenant_id = ANY($1)`, [tenants]);
      await c.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [tenants]);
      await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenants]);
    } finally {
      c.release();
      await pool.end();
    }
  }, 120_000);

  it('devolve os 501 grants — nenhum descartado — em exatamente DUAS round-trips', async () => {
    const scope = await runWithTenantContext(A, () =>
      runWithQueryCounter(async (counter) => {
        const s = await permissions().resolveScope({
          id: semeadoA.pessoa_id,
          status: 'ativa',
        } as never);
        // `forPessoa` + `forAuthorization`. Nem JOIN (#693) nem lotes: a
        // correção não pode mudar o orçamento da #525.
        expect(counter.count).toBe(2);
        return s;
      }),
    );

    // O número da issue. Antes da #738: 500, com o grant perdido escolhido
    // pela ordem dos ids.
    expect(scope.entidades).toHaveLength(PROFILE_COUNT);
    expect(new Set(scope.entidades)).toEqual(new Set(semeadoA.entidade_ids));

    // Cada grant carrega o SEU profile, e todos são do tenant A.
    const profileIds = [...scope.byEntity.values()].map((r) => r.profile.id).sort();
    expect(profileIds).toEqual([...semeadoA.profile_ids].sort());
    for (const r of scope.byEntity.values()) {
      expect({ t: r.profile.tenant_id, a: r.profile.agent_id }).toEqual({
        t: A.tenant_id,
        a: A.agent_id,
      });
    }
  }, 60_000);

  it('isolamento: profiles homônimos de OUTRO tenant não entram no escopo — nem quando uma permissão aponta para eles', async () => {
    const scopeA = await runWithTenantContext(A, () =>
      permissions().resolveScope({ id: semeadoA.pessoa_id, status: 'ativa' } as never),
    );

    // A 502ª permissão (profile de B) foi descartada fail-closed: sem profile
    // no tenant corrente, sem grant. E nenhum id de B aparece.
    expect(scopeA.entidades).not.toContain(semeadoA.entidade_estrangeira);
    expect(scopeA.byEntity.has(semeadoA.entidade_estrangeira!)).toBe(false);
    const idsDeB = new Set(semeadoB.profile_ids);
    for (const r of scopeA.byEntity.values()) {
      expect(idsDeB.has(r.profile.id)).toBe(false);
      expect(r.profile.tenant_id).toBe(A.tenant_id);
    }

    // E o espelho: B resolve os SEUS 501, e nada de A.
    const scopeB = await runWithTenantContext(B, () =>
      permissions().resolveScope({ id: semeadoB.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeB.entidades).toHaveLength(PROFILE_COUNT);
    expect(new Set(scopeB.entidades)).toEqual(new Set(semeadoB.entidade_ids));
    const idsDeA = new Set(semeadoA.profile_ids);
    for (const r of scopeB.byEntity.values()) {
      expect(idsDeA.has(r.profile.id)).toBe(false);
      expect(r.profile.tenant_id).toBe(B.tenant_id);
    }
  }, 60_000);

  it('profilesRepo.forAuthorization: entregue os 1002 ids dos DOIS tenants, devolve só os 501 do tenant corrente, por id, sem teto', async () => {
    const { profilesRepo } = repos();
    const todos = [...semeadoA.profile_ids, ...semeadoB.profile_ids];

    const rows = await runWithTenantContext(A, () =>
      runWithQueryCounter(async (counter) => {
        const r = await profilesRepo.forAuthorization(todos);
        expect(counter.count).toBe(1);
        return r;
      }),
    );

    expect(rows).toHaveLength(PROFILE_COUNT);
    expect(rows.map((r) => r.id)).toEqual([...semeadoA.profile_ids].sort());
    expect(rows.every((r) => r.tenant_id === A.tenant_id && r.agent_id === A.agent_id)).toBe(
      true,
    );
  }, 60_000);
});
