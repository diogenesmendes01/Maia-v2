/**
 * Issue #700 — a SONDA DA MASSA do gate do turno, em Postgres real.
 *
 * ## O que este arquivo prova, e por que a sonda unitária não bastava
 *
 * `tests/unit/scripts/turn-context-resolve-scope-medido.spec.ts` prova o
 * CAMINHO: um turno real (`runTurnOnce`) chama o `resolveScope` de produção e
 * o contador registra as leituras — com repositórios dublados. O segundo modo
 * de falha que a #700 nomeia não mora no caminho: mora nas LINHAS. Se a massa
 * do harness (`seedPair`/`seedPerson`) deixar de semear `permissoes` ou
 * `permission_profiles`, o caminho continua íntegro, as duas leituras
 * acontecem, e o `resolveScope` devolve escopo VAZIO — o turno medido renderiza
 * um "## Escopo desta conversa" que não custa o que custa em produção, e a
 * cardinalidade 1/10/100/501 vira ficção.
 *
 * Aqui a massa é semeada pelo MESMO código do harness (`seedPair`, exportado
 * para isto) num Postgres de verdade, e cada pessoa do par é resolvida pelo
 * `resolveScope` de produção (`src/governance/permissions.ts`), sob o contexto
 * de tenant de produção e com o contador de queries de produção. A asserção é
 * sobre o que foi EXECUTADO e DEVOLVIDO: N linhas em `permissoes` → escopo
 * de N entidades, N profiles DISTINTOS resolvidos, em exatamente duas
 * round-trips.
 *
 * ## A cardinalidade acima do teto antigo
 *
 * A #738/#744 removeu o `LIMIT 500` da leitura de autorização
 * (`profilesRepo.byIds` → `profilesRepo.forAuthorization`). A massa do gate
 * semeia uma pessoa com `ACIMA_DO_TETO_ANTIGO` (501) permissões sobre 501
 * profiles distintos — e este spec cobra que os 501 voltem. Um `.limit(500)`
 * reintroduzido fica vermelho aqui (500 ≠ 501) antes de ficar vermelho no
 * gate.
 *
 * ## Controle (anti-vacuidade)
 *
 * O último caso APAGA as `permissoes` de uma pessoa semeada e afirma que o
 * mesmo `resolveScope` passa a devolver escopo vazio: é a regressão "a massa
 * deixou de semear a tabela" executada de verdade, e a prova de que as
 * asserções acima dependem das linhas — não passariam com escopo vazio.
 *
 * Skipped without TEST_DB_URL, como as demais specs de integração. A massa usa
 * o prefixo `bench525-` do harness e é removida pelo `cleanup` dele.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import type { Pessoa } from '@/db/schema.js';
import {
  ACIMA_DO_TETO_ANTIGO,
  CARDINALITIES,
  cleanup,
  personFor,
  seedPair,
  type Pair,
} from '../../scripts/turn-context-benchmark.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
let pair: Pair;

d('#700 — a massa do gate semeia permissoes/permission_profiles, e o resolveScope de produção as resolve', () => {
  const permissions = moduloDeProducao(() => import('@/governance/permissions.js'));

  /** O `resolveScope` de produção, no contexto do par, com o contador de produção. */
  async function resolver(entities: number): Promise<{
    entidades: string[];
    byEntity: Map<string, { permissao: { id: string }; profile: { id: string } }>;
    round_trips: number;
  }> {
    const person = personFor(pair, entities);
    return runWithTenantContext({ tenant_id: pair.tenant_id, agent_id: pair.agent_id }, () =>
      runWithQueryCounter(async (counter) => {
        const scope = await permissions().resolveScope(person.pessoa as unknown as Pessoa);
        return {
          entidades: scope.entidades,
          byEntity: scope.byEntity as unknown as Map<
            string,
            { permissao: { id: string }; profile: { id: string } }
          >,
          round_trips: counter.count,
        };
      }),
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    const c = await pool.connect();
    try {
      // Massa órfã de uma corrida abortada envenenaria a cardinalidade.
      await cleanup(c);
      // O par 0, com a identidade `profile` do gate canônico — o MESMO código
      // que `main()` roda para cada um dos 50 pares.
      pair = await seedPair(c, 0, 'profile');
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    try {
      await cleanup(c);
    } finally {
      c.release();
      await pool.end();
    }
  });

  it('semeia uma pessoa por cardinalidade, e as duas tabelas do escopo têm as linhas que o gate promete', async () => {
    expect(pair.people.map((p) => p.entities)).toEqual([...CARDINALITIES]);
    expect(pair.profile_ids).toHaveLength(Math.max(...CARDINALITIES));

    const c = await pool.connect();
    try {
      for (const person of pair.people) {
        const perms = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM permissoes
            WHERE tenant_id = $1 AND agent_id = $2 AND pessoa_id = $3 AND status = 'ativa'`,
          [pair.tenant_id, pair.agent_id, person.pessoa_id],
        );
        expect({ entities: person.entities, permissoes: Number(perms.rows[0]!.n) }).toEqual({
          entities: person.entities,
          permissoes: person.entities,
        });
      }
      const profiles = await c.query<{ n: string }>(
        `SELECT count(DISTINCT id)::text AS n FROM permission_profiles
          WHERE tenant_id = $1 AND agent_id = $2`,
        [pair.tenant_id, pair.agent_id],
      );
      expect(Number(profiles.rows[0]!.n)).toBe(Math.max(...CARDINALITIES));
    } finally {
      c.release();
    }
  });

  it('o resolveScope de PRODUÇÃO resolve cada pessoa ao tamanho semeado — 1, 10, 100 e 501 — em duas round-trips', async () => {
    for (const n of CARDINALITIES) {
      const scope = await resolver(n);
      expect({ n, resolvido: scope.entidades.length }).toEqual({ n, resolvido: n });
      expect(scope.byEntity.size).toBe(n);
      // Cada permissão aponta para um profile DISTINTO, e todos vieram do
      // banco — do par certo (o id carrega o tenant no nome).
      const profileIds = new Set([...scope.byEntity.values()].map((r) => r.profile.id));
      expect(profileIds.size).toBe(n);
      for (const id of profileIds) expect(id.startsWith(`${pair.tenant_id}-prof-`)).toBe(true);
      // Exatamente as duas leituras do `resolveScope` da `main`
      // (`forPessoa` + `forAuthorization`), contadas pelo contador de produção.
      expect({ n, round_trips: scope.round_trips }).toEqual({ n, round_trips: 2 });
    }
  });

  it('ACIMA DO TETO ANTIGO: os 501 profiles distintos voltam — nenhum grant descartado por LIMIT', async () => {
    expect(ACIMA_DO_TETO_ANTIGO).toBeGreaterThan(500);
    const scope = await resolver(ACIMA_DO_TETO_ANTIGO);
    expect(scope.entidades).toHaveLength(ACIMA_DO_TETO_ANTIGO);
    const profileIds = new Set([...scope.byEntity.values()].map((r) => r.profile.id));
    expect(profileIds.size).toBe(ACIMA_DO_TETO_ANTIGO);
    // E o escopo resolvido é EXATAMENTE o que a massa semeou para essa pessoa
    // — as 501 primeiras entidades do par, na ordem das permissões.
    expect(scope.entidades).toEqual(pair.entidade_ids.slice(0, ACIMA_DO_TETO_ANTIGO));
    expect(scope.round_trips).toBe(2);
  });

  it('CONTROLE: sem as linhas de `permissoes` o MESMO resolveScope devolve escopo vazio — as asserções acima dependem da massa', async () => {
    // A regressão "a massa deixou de semear a tabela", executada de verdade
    // sobre a pessoa de cardinalidade 1. Roda por último: a partir daqui o
    // par não tem mais a forma que o gate promete.
    const antes = await resolver(1);
    expect(antes.entidades).toHaveLength(1);

    const c = await pool.connect();
    try {
      const apagadas = await c.query(
        `DELETE FROM permissoes WHERE tenant_id = $1 AND agent_id = $2 AND pessoa_id = $3`,
        [pair.tenant_id, pair.agent_id, personFor(pair, 1).pessoa_id],
      );
      expect(apagadas.rowCount).toBe(1);
    } finally {
      c.release();
    }

    const depois = await resolver(1);
    expect(depois.entidades).toEqual([]);
    expect(depois.byEntity.size).toBe(0);
    // Uma leitura só: sem permissões com entidade, o `resolveScope` nem chega
    // ao `forAuthorization` — é assim que "massa faltando" apareceria no gate
    // (escopo resolvido=0, e leituras por turno abaixo do que a massa cheia
    // produz).
    expect(depois.round_trips).toBe(1);
  });
});
