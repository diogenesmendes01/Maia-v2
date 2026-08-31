/**
 * A remoção do teto de 500 profiles é uma MUDANÇA DE AUTORIZAÇÃO, e era a
 * única do #525 sem teste.
 *
 * O caminho antigo lia em dois passos: `permissoesRepo.forPessoa` (sem teto) e
 * depois `profilesRepo.byIds(ids, limit = 500)` — com `ORDER BY id` e `LIMIT
 * 500`. Quem tivesse permissões apontando para mais de 500 profiles distintos
 * via as do 501º em diante caírem fora do `Map`, e o `if (!profile) continue`
 * do resolvedor descartava a permissão em silêncio. Ou seja: um grant REAL,
 * concedido, sumia — e a escolha de QUAL sumia era a ordem alfabética do id do
 * profile, que não é decisão de autorização nenhuma.
 *
 * O `INNER JOIN` não tem esse corte. A direção da mudança é PERMISSIVA nessa
 * borda: onde antes se perdia grant, agora ele resolve. Isso precisa de teste
 * justamente porque é permissivo — e porque o resto do #525 é sobre custo, não
 * sobre autorização, então ninguém olharia para cá.
 *
 * O que NÃO muda, e os outros casos de `turn-context-escopo-real-db.spec.ts`
 * já cobrem: cada linha continua exigindo permissão ATIVA da pessoa e profile
 * do MESMO tenant/agent (o `ON` do join), `entidade_id` não nula, e
 * `mergeLimits` por permissão.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa } from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'i525teto-tenant';
const AG = 'i525teto-agent';
const PESSOA = '5b5c5d5e-0000-4000-8000-000000000525';

/**
 * 501 e não 500: o teto antigo era `LIMIT 500`, então é o 501º profile — na
 * ordem de `id` ascendente — que provava a perda. Com um a mais que o teto, a
 * diferença entre os dois caminhos é exatamente UMA entidade.
 */
const QUANTOS = 501;

let pool: pg.Pool;

const limpar = async (): Promise<void> => {
  const c = await pool.connect();
  try {
    for (const t of ['permissoes', 'entidades', 'permission_profiles', 'pessoas']) {
      await c.query(`DELETE FROM ${t} WHERE tenant_id = $1 AND agent_id = $2`, [T, AG]);
    }
  } finally {
    c.release();
  }
};

d('#525 — o teto de 500 profiles descartava grant concedido', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING', [T]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING',
      [AG, T],
    );
    await limpar();

    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO pessoas(id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,$3,'Muitos perfis','+5511900000525','dono','ativa')`,
        [PESSOA, T, AG],
      );
      // Um profile e uma entidade por permissão, todos DISTINTOS: é o número de
      // profiles distintos que o teto antigo cortava. O id é zero-padded para
      // que a ordem alfabética (a que o `ORDER BY id` usava) seja a numérica.
      await c.query(
        `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
         SELECT 'i525teto-' || lpad(g::text, 4, '0'), $1, $2, 'p' || g, ARRAY['consultar_saldo'], '10.00'
           FROM generate_series(0, $3::int - 1) AS g`,
        [T, AG, QUANTOS],
      );
      // `entidades.id` é PK GLOBAL, não escopada por tenant: um uuid fixo aqui
      // colide com a fixture de qualquer outro spec e derruba o `beforeAll`
      // DELE — foi o que aconteceu na primeira versão deste arquivo, e o spec
      // dos goldens do prompt parou de rodar por minha causa. `gen_random_uuid()`
      // e o vínculo pelo NOME eliminam o acoplamento.
      await c.query(
        `INSERT INTO entidades(tenant_id, agent_id, nome, tipo)
         SELECT $1, $2, 'i525teto-e' || lpad(g::text, 4, '0'), 'pj'
           FROM generate_series(0, $3::int - 1) AS g`,
        [T, AG, QUANTOS],
      );
      await c.query(
        `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status, limites)
         SELECT $1, $2, $3, e.id, 'leitor',
                'i525teto-' || right(e.nome, 4),
                'ativa', '{}'::jsonb
           FROM entidades e
          WHERE e.tenant_id = $1 AND e.agent_id = $2 AND e.nome LIKE 'i525teto-e%'`,
        [T, AG, PESSOA],
      );
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    await limpar();
    await pool?.end();
  });

  const pessoa = { id: PESSOA, status: 'ativa' } as Pessoa;

  it('501 permissões com profiles distintos resolvem TODAS — nenhuma some pelo teto', async () => {
    const { resolveScope } = await import('../../src/governance/permissions.js');
    const escopo = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
      resolveScope(pessoa),
    );

    expect(
      escopo.entidades.length,
      `${QUANTOS - escopo.entidades.length} grant(s) concedido(s) sumiram na resolução`,
    ).toBe(QUANTOS);
    expect(escopo.byEntity.size).toBe(QUANTOS);
  });

  it('o grant que o teto descartava é o do ÚLTIMO profile, e ele está lá com o profile certo', async () => {
    // Sem esta asserção, um resolvedor que devolvesse 501 entidades quaisquer
    // passaria no caso acima. O que interessa é que a entidade cujo profile
    // ficava FORA do `LIMIT 500` resolva, e resolva para o profile DELA.
    const { resolveScope } = await import('../../src/governance/permissions.js');
    const escopo = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
      resolveScope(pessoa),
    );

    const sufixo = String(QUANTOS - 1).padStart(4, '0');
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM entidades WHERE tenant_id = $1 AND agent_id = $2 AND nome = $3`,
      [T, AG, `i525teto-e${sufixo}`],
    );
    const grant = escopo.byEntity.get(r.rows[0]!.id);
    expect(grant, 'a entidade do 501º profile não resolveu').toBeDefined();
    expect(grant!.profile.id).toBe(`i525teto-${sufixo}`);
    expect(grant!.profile.acoes).toEqual(['consultar_saldo']);
  });

  it('CONTROLE: uma permissão REVOGADA continua fora, mesmo com o teto removido', async () => {
    // Tirar o teto não pode ter afrouxado o resto. Este caso garante que o que
    // some do escopo some por DECISÃO de autorização, não por corte de recurso.
    const alvo = await pool.query<{ id: string }>(
      `SELECT id FROM entidades WHERE tenant_id = $1 AND agent_id = $2 AND nome = 'i525teto-e0000'`,
      [T, AG],
    );
    await pool.query(
      `UPDATE permissoes SET status = 'revogada'
        WHERE tenant_id = $1 AND agent_id = $2 AND entidade_id = $3`,
      [T, AG, alvo.rows[0]!.id],
    );
    try {
      const { resolveScope } = await import('../../src/governance/permissions.js');
      const escopo = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        resolveScope(pessoa),
      );
      expect(escopo.entidades.length).toBe(QUANTOS - 1);
      expect(escopo.byEntity.get(alvo.rows[0]!.id)).toBeUndefined();
    } finally {
      await pool.query(
        `UPDATE permissoes SET status = 'ativa'
          WHERE tenant_id = $1 AND agent_id = $2`,
        [T, AG],
      );
    }
  });
});
