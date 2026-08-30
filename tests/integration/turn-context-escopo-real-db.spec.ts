/**
 * Issue #525 — `resolveScope` resolve o MESMO escopo em UMA ida ao banco.
 *
 * ## Por que este arquivo precisa de Postgres
 *
 * Esta é a leitura do CAMINHO DE AUTORIZAÇÃO: ela decide sobre quais entidades
 * a pessoa pode agir, sob qual profile e com qual teto de valor. Fundir as duas
 * leituras que ela fazia (`permissoes`, e depois `permission_profiles` com os
 * `profile_id` colhidos) num `INNER JOIN` só é legítimo se a resolução for
 * exatamente a mesma — e "exatamente a mesma" tem três metades que um dublê não
 * consegue provar:
 *
 *  1. **Fail-closed.** Uma permissão cujo profile não resolve continua NÃO
 *     virando grant. No JS isso era `if (!profile) continue`; no SQL é o
 *     `INNER`. Um `LEFT JOIN` distraído passaria em qualquer teste que só
 *     contasse entidades, e concederia acesso sem profile.
 *  2. **Isolamento.** O `ON` liga `(tenant_id, agent_id)` dos DOIS lados. Se
 *     ligasse só o id, um `permissoes` apontando para o profile de OUTRO tenant
 *     resolveria — com a lista de ações e o limite de gasto daquele tenant. É a
 *     mesma classe de vazamento que a #511 fechou ao trocar `profilesRepo.byId`
 *     (sem escopo) por `byIds` (escopado); aqui a proteção mudou de lugar, do
 *     JS para o SQL, e por isso precisa ser reprovada aqui.
 *  3. **Limites efetivos.** `mergeLimits` continua sendo aplicado por
 *     permissão, então um `limites` explícito continua ganhando do
 *     `limite_default` do profile — e `limite_default` é `numeric`, que só
 *     chega ao JS com a forma certa vindo de um servidor de verdade.
 *
 * O que este arquivo NÃO prova: que os bytes do prompt não mudaram. Isso é de
 * `tests/integration/turn-context-prompt-bytes-real-db.spec.ts`, que compara o
 * prompt inteiro com um golden capturado ANTES desta mudança.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import type { Pessoa } from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const A = { tenant_id: 'i525-esc-tA', agent_id: 'i525-esc-agA' };
const B = { tenant_id: 'i525-esc-tB', agent_id: 'i525-esc-agB' };

const PESSOA_A = '00000000-0000-4000-a000-000000000001';
const PESSOA_B = '00000000-0000-4000-a000-000000000002';

let pool: pg.Pool;
/** Ids das entidades de A, na ordem em que as permissões foram criadas. */
const entsA: string[] = [];
let entB = '';

async function tenant(c: pg.PoolClient, e: { tenant_id: string; agent_id: string }): Promise<void> {
  await c.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
    e.tenant_id,
  ]);
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
    [e.agent_id, e.tenant_id],
  );
}

async function entidade(
  c: pg.PoolClient,
  e: { tenant_id: string; agent_id: string },
  nome: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES ($1,$2,$3,'pj') RETURNING id`,
    [e.tenant_id, e.agent_id, nome],
  );
  return r.rows[0]!.id;
}

/**
 * `permission_profiles.id` é PK GLOBAL (não é escopada por tenant), então dois
 * tenants não podem ter o mesmo id de profile. O caso de vazamento que resta —
 * e é o que a #511 fechou — é uma linha de `permissoes` de A apontando para um
 * `profile_id` que pertence a B. `PROF_SO_B` é esse profile: ele existe, é
 * irrestrito, e a permissão de A que aponta para ele NÃO pode virar grant.
 */
const PROF_A = 'i525-esc-prof-a';
const PROF_B = 'i525-esc-prof-b';
const PROF_SO_B = 'i525-esc-prof-so-b';

async function seed(): Promise<void> {
  const c = await pool.connect();
  try {
    await tenant(c, A);
    await tenant(c, B);

    for (const [e, pessoa] of [
      [A, PESSOA_A],
      [B, PESSOA_B],
    ] as const) {
      await c.query(
        `INSERT INTO pessoas(id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1,$2,$3,'P','+551190000${e === A ? '0011' : '0022'}','dono','ativa')`,
        [pessoa, e.tenant_id, e.agent_id],
      );
    }

    await c.query(
      `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'A restrito',ARRAY['consultar_saldo'],'10.50')`,
      [PROF_A, A.tenant_id, A.agent_id],
    );
    // Os DOIS profiles de B são irrestritos e com teto altíssimo: se alguma
    // linha de A resolvesse para um deles, o grant sairia com `acoes: ['*']` e
    // teto 999999 — o vazamento é visível no CONTEÚDO, não só na contagem.
    await c.query(
      `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
       VALUES ($1,$3,$4,'B irrestrito',ARRAY['*'],'999999'),
              ($2,$3,$4,'só B',ARRAY['*'],'999999')`,
      [PROF_B, PROF_SO_B, B.tenant_id, B.agent_id],
    );

    for (const nome of ['Alfa', 'Beta', 'Gama', 'Delta']) entsA.push(await entidade(c, A, `i525-${nome}`));
    entB = await entidade(c, B, 'i525-DeB');

    await c.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status, limites)
       VALUES ($1,$2,$3,$4,'dono',$7,'ativa','{}'::jsonb),
              ($1,$2,$3,$5,'leitor',$7,'ativa','{"valor_max":42}'::jsonb),
              ($1,$2,$3,$6,'leitor',$8,'ativa','{}'::jsonb)`,
      [A.tenant_id, A.agent_id, PESSOA_A, entsA[0], entsA[1], entsA[2], PROF_A, PROF_SO_B],
    );
    // Uma permissão REVOGADA (sobre Delta) e uma SEM entidade: nenhuma das
    // duas pode virar grant, e as duas passam pelo mesmo join.
    await c.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status, limites)
       VALUES ($1,$2,$3,$4,'dono',$5,'revogada','{}'::jsonb),
              ($1,$2,$3,NULL,'dono',$5,'ativa','{}'::jsonb)`,
      [A.tenant_id, A.agent_id, PESSOA_A, entsA[3], PROF_A],
    );
    await c.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status, limites)
       VALUES ($1,$2,$3,$4,'dono',$5,'ativa','{}'::jsonb)`,
      [B.tenant_id, B.agent_id, PESSOA_B, entB, PROF_B],
    );
  } finally {
    c.release();
  }
}

async function limpar(): Promise<void> {
  const c = await pool.connect();
  try {
    for (const e of [A, B]) {
      for (const tabela of ['permissoes', 'entidades', 'permission_profiles', 'pessoas']) {
        await c.query(`DELETE FROM ${tabela} WHERE tenant_id = $1 AND agent_id = $2`, [
          e.tenant_id,
          e.agent_id,
        ]);
      }
    }
  } finally {
    c.release();
  }
}

const pessoaA = { id: PESSOA_A, status: 'ativa' } as Pessoa;

d('#525 — resolveScope em UMA leitura, sem afrouxar autorização', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await limpar();
    await seed();
  }, 60_000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('custa UM statement, medido pelo contador de produção', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const n = await runWithTenantContext(A, () =>
      runWithQueryCounter(async (counter) => {
        await resolveScope(pessoaA);
        return counter.count;
      }),
    );
    expect(n).toBe(1);
  });

  it('resolve as MESMAS entidades, na mesma ordem, que a resolução em duas leituras', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const { permissoesRepo, profilesRepo } = await import('@/db/repositories.js');

    const [novo, antigo] = await runWithTenantContext(A, async () => {
      const n = await resolveScope(pessoaA);
      // A resolução ANTIGA, reconstruída aqui a partir dos repositórios que
      // ainda existem: duas leituras, e o `if (!profile) continue` em JS.
      const perms = (await permissoesRepo.forPessoa(PESSOA_A)).filter((p) => p.entidade_id);
      const profiles = await profilesRepo.byIds(perms.map((p) => p.profile_id));
      const porId = new Map(profiles.map((pr) => [pr.id, pr]));
      const entidades = perms.filter((p) => porId.has(p.profile_id!)).map((p) => p.entidade_id!);
      return [n, { entidades, porId }];
    });

    expect(novo.entidades).toEqual(antigo.entidades);
    // Duas entidades resolvem; a terceira aponta para um profile que só existe
    // no outro tenant e por isso NÃO vira grant.
    expect(novo.entidades).toHaveLength(2);
    expect(novo.entidades).toEqual([entsA[0], entsA[1]]);
  });

  it('fail-closed: permissão sem profile resolvível não vira grant', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const escopo = await runWithTenantContext(A, () => resolveScope(pessoaA));
    expect(escopo.byEntity.has(entsA[2]!)).toBe(false);
    expect(escopo.entidades).not.toContain(entsA[2]);
  });

  it('nenhum grant de A carrega profile de B', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const escopo = await runWithTenantContext(A, () => resolveScope(pessoaA));

    for (const [, grant] of escopo.byEntity) {
      expect(grant.profile.tenant_id).toBe(A.tenant_id);
      expect(grant.profile.agent_id).toBe(A.agent_id);
      // O vazamento nunca foi abstrato: o profile de B carrega uma lista de
      // ações irrestrita e um teto de gasto de seis dígitos.
      expect(grant.profile.acoes).not.toContain('*');
      expect(grant.effective_limits.valor_max).toBeLessThan(1000);
    }
    expect(escopo.byEntity.get(entsA[0]!)!.profile.id).toBe(PROF_A);
  });

  it('preserva a precedência de limites: `limites` da permissão ganha do profile', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const escopo = await runWithTenantContext(A, () => resolveScope(pessoaA));
    // Alfa herda o `limite_default` do profile (numeric '10.50' → 10.5)…
    expect(escopo.byEntity.get(entsA[0]!)!.effective_limits.valor_max).toBe(10.5);
    // …e Beta usa o override explícito da própria permissão.
    expect(escopo.byEntity.get(entsA[1]!)!.effective_limits.valor_max).toBe(42);
  });

  it('permissão revogada e permissão sem entidade continuam fora do escopo', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const escopo = await runWithTenantContext(A, () => resolveScope(pessoaA));
    // Delta só tem permissão REVOGADA: o `status = 'ativa'` do WHERE continua
    // valendo depois do join.
    expect(escopo.entidades).not.toContain(entsA[3]);
    // …e a permissão sem `entidade_id` não vira uma entrada `undefined`.
    expect(escopo.entidades.every((e) => typeof e === 'string')).toBe(true);
    expect(escopo.entidades).toHaveLength(2);
  });

  it('a entidade do outro tenant nunca aparece', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const escopo = await runWithTenantContext(A, () => resolveScope(pessoaA));
    expect(escopo.entidades).not.toContain(entB);
    // …e o inverso também: B vê a sua e só a sua.
    const deB = await runWithTenantContext(B, () =>
      resolveScope({ id: PESSOA_B, status: 'ativa' } as Pessoa),
    );
    expect(deB.entidades).toEqual([entB]);
    expect(deB.byEntity.get(entB)!.profile.acoes).toEqual(['*']);
  });

  /**
   * O ganho, medido — porque "uma leitura em vez de duas" só vale se as duas
   * eram SEQUENCIAIS, e estas eram: a segunda esperava os `profile_id` que a
   * primeira trouxe. É o que distingue esta fusão das quatro que foram
   * desfeitas (ver `turn-context-custo-de-fundir-real-db.spec.ts`): aquelas
   * fundiam leituras já concorrentes, e alongavam o `max()` do turno.
   *
   * A asserção é FOLGADA de propósito (não pode ser MAIS LENTA que 1,3× as duas
   * em série). O número medido quando isto foi escrito, com uma entidade em
   * escopo, foi 1,36 ms → 0,96 ms de p50 — 30% mais rápido. Um teste de tempo
   * apertado numa máquina compartilhada é vermelho falso garantido; o que
   * importa aqui é que a direção nunca se inverta sem ninguém notar.
   */
  it('a leitura única não é mais lenta que as duas em série (medido)', async () => {
    const { permissoesRepo, profilesRepo } = await import('@/db/repositories.js');

    const medir = async (f: () => Promise<unknown>): Promise<number> => {
      for (let i = 0; i < 20; i++) await f();
      const t: number[] = [];
      for (let i = 0; i < 150; i++) {
        const a = performance.now();
        await f();
        t.push(performance.now() - a);
      }
      t.sort((x, y) => x - y);
      return t[75]!;
    };

    const { serie, junto } = await runWithTenantContext(A, async () => ({
      serie: await medir(async () => {
        const perms = (await permissoesRepo.forPessoa(PESSOA_A)).filter((p) => p.entidade_id);
        if (perms.length === 0) return [];
        return profilesRepo.byIds(perms.map((p) => p.profile_id));
      }),
      junto: await medir(() => permissoesRepo.forPessoaComProfile(PESSOA_A)),
    }));

    console.log(
      `[#525] escopo: duas leituras em série p50=${serie.toFixed(3)}ms · um JOIN p50=${junto.toFixed(3)}ms`,
    );
    expect(junto).toBeLessThan(serie * 1.3);
  });

  it('pessoa inativa custa ZERO statements e resolve para escopo vazio', async () => {
    const { resolveScope } = await import('@/governance/permissions.js');
    const { escopo, n } = await runWithTenantContext(A, () =>
      runWithQueryCounter(async (counter) => {
        const e = await resolveScope({ id: PESSOA_A, status: 'suspensa' } as Pessoa);
        return { escopo: e, n: counter.count };
      }),
    );
    expect(n).toBe(0);
    expect(escopo.entidades).toEqual([]);
  });
});
