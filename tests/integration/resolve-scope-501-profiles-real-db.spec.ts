/**
 * Issue #738 — `resolveScope` contra Postgres real: 501 profiles DISTINTOS e
 * isolamento por tenant E por agent, cada predicado pinado separadamente.
 *
 * O defeito morava em SQL — `profilesRepo.byIds(ids, limit = 500)`, o `LIMIT`
 * que cortava a leitura de perfis por ordem de id acima de 500 profiles
 * distintos e fazia `resolveScope` descartar grants reais em silêncio —, então
 * um repositório mockado não o teria. Aqui a leitura é a de produção
 * (`profilesRepo.forAuthorization`, sem `LIMIT`), o banco é real e as
 * propriedades que o dono exigiu são afirmadas juntas:
 *
 *  1. **501 profiles distintos ⇒ 501 grants resolvidos**, em exatamente DUAS
 *     round-trips (`forPessoa` + `forAuthorization`), contadas pelo contador de
 *     produção (`src/db/query-counter.ts`) — a correção não pode comprar
 *     correção com um JOIN (#693, fechada) nem com paginação.
 *  2. **Isolamento, um predicado por vez.** A revisão da PR #744 (sonda do
 *     revisor) mostrou que a primeira versão desta spec provava a CONJUNÇÃO
 *     `tenant_id AND agent_id` e não cada predicado: o segundo tenant tinha
 *     outro agent, então removendo `eq(tenant_id)` o predicado de agent
 *     sozinho isolava tudo e a spec ficava verde indevidamente (e vice-versa).
 *     Cada predicado agora tem um caso que SÓ ele salva:
 *
 *       - AGENT — um segundo agent no MESMO tenant A (`i738-agA2`; `agents.id`
 *         é PK global, por isso um id novo), com 501 profiles homônimos e uma
 *         permissão de A apontando para um profile dele. Sem `eq(agent_id)` o
 *         predicado de tenant não separa A de A2 ⇒ vermelho.
 *       - TENANT — como `agents.id` é PK global, um agent legítimo nunca
 *         pertence a dois tenants; a única forma de o predicado de tenant
 *         importar é a LINHA INCONSISTENTE: `permission_profiles` com
 *         `tenant_id = B` e `agent_id = 'i738-agA'`. As FKs da tabela são
 *         separadas (`tenant_id → tenants(id)`, `agent_id → agents(id)`; sem FK
 *         composta nem CHECK — ver `\d permission_profiles`), então o banco
 *         ACEITA essa linha: é isto que faz do predicado de tenant defesa em
 *         profundidade, e não redundância. Sem `eq(tenant_id)` a linha entra
 *         no escopo de A ⇒ vermelho.
 *
 *     O terceiro tenant/agent (B) fica como o caso ordinário — outro tenant,
 *     outro agent, profiles homônimos e uma permissão cruzada.
 *
 *     `permission_profiles.id` é PK GLOBAL (TEXT), então os ids carregam o
 *     escopo no nome e o que se repete entre escopos é o NOME.
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
/** OUTRO agent do MESMO tenant A — pina o predicado de agent_id. */
const A2 = { tenant_id: 'i738-tA', agent_id: 'i738-agA2' };
/** Outro tenant, outro agent — o caso ordinário de isolamento entre tenants. */
const B = { tenant_id: 'i738-tB', agent_id: 'i738-agB' };
/** A linha inconsistente: tenant de B, agent de A — pina o predicado de tenant_id. */
const PROFILE_INCONSISTENTE = 'i738-inconsistente-tB-agA';

/** Um além do `LIMIT 500` que a leitura antiga tinha. */
const PROFILE_COUNT = 501;

type Semeado = {
  pessoa_id: string;
  entidade_ids: string[];
  profile_ids: string[];
};

/** As entidades de A cujas permissões apontam para profiles FORA do escopo (A, agA). */
type Cruzadas = {
  outro_tenant: string;
  outro_agent_mesmo_tenant: string;
  linha_inconsistente: string;
};

let pool: pg.Pool;
let semeadoA: Semeado;
let semeadoA2: Semeado;
let semeadoB: Semeado;
let cruzadas: Cruzadas;

/**
 * Semeia um escopo inteiro: 501 profiles (ids prefixados por `tag`, NOMES
 * iguais em todos os escopos), 501 entidades, uma pessoa não-dona e 501
 * permissões, a i-ésima entidade apontando para o i-ésimo profile.
 */
async function semearEscopo(
  c: pg.PoolClient,
  scope: { tenant_id: string; agent_id: string },
  tag: string,
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
     SELECT $1 || '-prof-' || lpad(g::text, 4, '0'), $2, $3,
            'i738-prof-' || lpad(g::text, 4, '0'),
            ARRAY['registrar_transacao'], 100
     FROM generate_series(1, $4) g
     ORDER BY g
     RETURNING id`,
    [tag, scope.tenant_id, scope.agent_id, PROFILE_COUNT],
  );
  const profile_ids = profiles.rows.map((r) => r.id);

  const entidades = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
     SELECT $1, $2, $3 || '-ent-' || lpad(g::text, 4, '0'), 'pj'
     FROM generate_series(1, $4) g
     ORDER BY g
     RETURNING id`,
    [scope.tenant_id, scope.agent_id, tag, PROFILE_COUNT],
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

/** Uma entidade nova de A com uma permissão da pessoa de A apontando para `profile_id`. */
async function permissaoCruzadaDeA(
  c: pg.PoolClient,
  nome: string,
  profile_id: string,
): Promise<string> {
  const ent = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES ($1, $2, $3, 'pj') RETURNING id`,
    [A.tenant_id, A.agent_id, nome],
  );
  await c.query(
    `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
     VALUES ($1, $2, $3, $4, 'operador', $5, 'ativa')`,
    [A.tenant_id, A.agent_id, semeadoA.pessoa_id, ent.rows[0]!.id, profile_id],
  );
  return ent.rows[0]!.id;
}

/** Os profiles resolvidos no escopo, como pares (id, tenant, agent). */
function perfisDe(scope: {
  byEntity: Map<string, { profile: { id: string; tenant_id: string; agent_id: string } }>;
}): Array<{ id: string; tenant_id: string; agent_id: string }> {
  return [...scope.byEntity.values()].map((r) => ({
    id: r.profile.id,
    tenant_id: r.profile.tenant_id,
    agent_id: r.profile.agent_id,
  }));
}

d('#738 — resolveScope com 501 profiles distintos, em Postgres real', () => {
  const permissions = moduloDeProducao(() => import('@/governance/permissions.js'));
  const repos = moduloDeProducao(() => import('@/db/repositories.js'));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    const c = await pool.connect();
    try {
      semeadoA = await semearEscopo(c, A, 'i738-tA-agA', '+5511738000001');
      semeadoA2 = await semearEscopo(c, A2, 'i738-tA-agA2', '+5511738000003');
      semeadoB = await semearEscopo(c, B, 'i738-tB-agB', '+5511738000002');

      // A linha inconsistente. Nenhuma FK a impede: `tenant_id` referencia
      // `tenants(id)` (B existe) e `agent_id` referencia `agents(id)` (agA
      // existe) SEPARADAMENTE. Se um dia uma FK composta (agent_id, tenant_id)
      // passar a rejeitar este INSERT, este `beforeAll` reprova e o caso do
      // predicado de tenant vira redundância documentada, não silêncio.
      await c.query(
        `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
         VALUES ($1, $2, $3, 'i738-prof-0001', ARRAY['registrar_transacao'], 100)`,
        [PROFILE_INCONSISTENTE, B.tenant_id, A.agent_id],
      );

      // Três permissões cruzadas da pessoa de A, uma por predicado que se quer
      // pinar — o id existe, só que fora do escopo (A, agA).
      cruzadas = {
        outro_tenant: await permissaoCruzadaDeA(
          c,
          'i738-tA-agA-ent-cruzada-outro-tenant',
          semeadoB.profile_ids[0]!,
        ),
        outro_agent_mesmo_tenant: await permissaoCruzadaDeA(
          c,
          'i738-tA-agA-ent-cruzada-outro-agent',
          semeadoA2.profile_ids[0]!,
        ),
        linha_inconsistente: await permissaoCruzadaDeA(
          c,
          'i738-tA-agA-ent-cruzada-inconsistente',
          PROFILE_INCONSISTENTE,
        ),
      };
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    // A2 vive no tenant A e a linha inconsistente no tenant B: a limpeza por
    // tenant cobre os dois.
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
    // pela ordem dos ids. (A pessoa tem 504 permissões: as 3 cruzadas caem
    // fail-closed — sem profile no escopo corrente, sem grant.)
    expect(scope.entidades).toHaveLength(PROFILE_COUNT);
    expect(new Set(scope.entidades)).toEqual(new Set(semeadoA.entidade_ids));

    // Cada grant carrega o SEU profile, e todos são de (A, agA).
    const perfis = perfisDe(scope);
    expect(perfis.map((p) => p.id).sort()).toEqual([...semeadoA.profile_ids].sort());
    expect(perfis.every((p) => p.tenant_id === A.tenant_id && p.agent_id === A.agent_id)).toBe(
      true,
    );
  }, 60_000);

  it('isolamento entre TENANTS: profiles homônimos de outro tenant não entram — nem quando uma permissão aponta para eles', async () => {
    const scopeA = await runWithTenantContext(A, () =>
      permissions().resolveScope({ id: semeadoA.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeA.entidades).not.toContain(cruzadas.outro_tenant);
    const idsDeB = new Set(semeadoB.profile_ids);
    expect(perfisDe(scopeA).some((p) => idsDeB.has(p.id))).toBe(false);

    // E o espelho: B resolve os SEUS 501, e nada de A.
    const scopeB = await runWithTenantContext(B, () =>
      permissions().resolveScope({ id: semeadoB.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeB.entidades).toHaveLength(PROFILE_COUNT);
    expect(new Set(scopeB.entidades)).toEqual(new Set(semeadoB.entidade_ids));
    const idsDeA = new Set(semeadoA.profile_ids);
    for (const p of perfisDe(scopeB)) {
      expect(idsDeA.has(p.id)).toBe(false);
      expect(p.tenant_id).toBe(B.tenant_id);
    }
  }, 60_000);

  it('pina o predicado de AGENT: outro agent do MESMO tenant não entra no escopo', async () => {
    // Só `eq(permission_profiles.agent_id, agent_id)` separa (A, agA) de
    // (A, agA2): os dois têm o mesmo tenant_id. Remover esse predicado deixa
    // este caso vermelho — e o de tenant sozinho não o salva.
    const scopeA = await runWithTenantContext(A, () =>
      permissions().resolveScope({ id: semeadoA.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeA.entidades).not.toContain(cruzadas.outro_agent_mesmo_tenant);
    expect(scopeA.byEntity.has(cruzadas.outro_agent_mesmo_tenant)).toBe(false);
    const idsDeA2 = new Set(semeadoA2.profile_ids);
    for (const p of perfisDe(scopeA)) {
      expect(idsDeA2.has(p.id)).toBe(false);
      expect(p.agent_id).toBe(A.agent_id);
    }

    // Espelho: A2 resolve os SEUS 501 e nenhum profile de agA.
    const scopeA2 = await runWithTenantContext(A2, () =>
      permissions().resolveScope({ id: semeadoA2.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeA2.entidades).toHaveLength(PROFILE_COUNT);
    expect(new Set(scopeA2.entidades)).toEqual(new Set(semeadoA2.entidade_ids));
    const idsDeA = new Set(semeadoA.profile_ids);
    for (const p of perfisDe(scopeA2)) {
      expect(idsDeA.has(p.id)).toBe(false);
      expect(p.agent_id).toBe(A2.agent_id);
    }
  }, 60_000);

  it('pina o predicado de TENANT: a linha inconsistente (tenant B, agent de A) não entra no escopo', async () => {
    // O agent bate (agA); só `eq(permission_profiles.tenant_id, tenant_id)`
    // recusa esta linha. Ela existe porque as FKs são separadas — o banco não a
    // impede, o predicado impede. Remover esse predicado deixa este caso
    // vermelho — e o de agent sozinho não o salva.
    const scopeA = await runWithTenantContext(A, () =>
      permissions().resolveScope({ id: semeadoA.pessoa_id, status: 'ativa' } as never),
    );
    expect(scopeA.entidades).not.toContain(cruzadas.linha_inconsistente);
    expect(scopeA.byEntity.has(cruzadas.linha_inconsistente)).toBe(false);
    for (const p of perfisDe(scopeA)) {
      expect(p.id).not.toBe(PROFILE_INCONSISTENTE);
      expect(p.tenant_id).toBe(A.tenant_id);
    }
  }, 60_000);

  it('profilesRepo.forAuthorization: entregue TODOS os ids (A, A2, B e a linha inconsistente), devolve só os 501 de (A, agA), por id, sem teto', async () => {
    const { profilesRepo } = repos();
    const todos = [
      ...semeadoA.profile_ids,
      ...semeadoA2.profile_ids,
      ...semeadoB.profile_ids,
      PROFILE_INCONSISTENTE,
    ];

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
