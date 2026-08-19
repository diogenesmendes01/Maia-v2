/**
 * Issue #571, revisão da PR #597 — a prova COMPORTAMENTAL do isolamento.
 *
 * ## O que a revisão apontou
 *
 * O gate verde da #571 não executava o caminho de worktree. No checkout do CI
 * `.git` é diretório, `resolveWorktreeScope()` devolve `null`, e os únicos
 * casos que consultavam o escopo real faziam `return` nesse estado. Alocação,
 * reciclagem, descoberta do git dir comum e duas rodadas simultâneas nunca
 * rodaram sob gate. A corrida de reciclagem — dois processos concluindo
 * "abandonado" a partir da MESMA observação e ambos saindo com o mesmo db —
 * era invisível para um teste single-process com escopo de mentira.
 *
 * ## O que este arquivo faz
 *
 * Cria `git worktree`s DE VERDADE num repositório temporário e dispara
 * PROCESSOS SEPARADOS em paralelo contra o mesmo registro de slots. Processo
 * separado é requisito: a memoização é por processo, e o interleaving de dois
 * `unlink` só existe entre processos.
 *
 * Três cenários, e o terceiro é o que fecha o achado:
 *
 *  1. slot livre — duas árvores, dois processos, dbs/bancos/URLs distintos;
 *  2. dono ausente — o slot de uma worktree que sumiu do disco é reciclado;
 *  3. slot stale DISPUTADO — todos os slots pré-semeados como abandonados e
 *     uma sonda por slot, todas soltas no mesmo instante. Com a reciclagem sem
 *     serialização, duas sondas saem com o mesmo `redisDb` (ou uma estoura por
 *     falta de slot). Com o mutex + fencing de geração, a saída é sempre uma
 *     permutação: um root por slot.
 *
 * Todo caso afirma `escopo !== null`. **Cair no caminho `scope === null` é
 * falha**, não motivo para `return` — foi assim que os 8 checks verdes da PR
 * original não provaram nada.
 *
 * ## O que ele NÃO faz
 *
 * Não toca no registro de slots do repositório real (`<repo>/.git/
 * maia-redis-slots/`): o repo de sonda tem `.git` próprio. Não conecta em
 * Postgres nem em Redis — a não-observabilidade cruzada com infra ao vivo é
 * `tests/integration/worktree-isolamento-canario.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  criarRepoDeSonda,
  rodarSondas,
  type RepoDeSonda,
  type RespostaDaSonda,
} from '../../helpers/worktree-de-sonda.js';

/** Boot de Node + tsx, N processos em paralelo, várias rodadas. */
const PRAZO = 180_000;

let repo: RepoDeSonda;

beforeEach(() => {
  repo = criarRepoDeSonda();
});

afterEach(() => {
  repo.destruir();
});

/** Escreve um arquivo de posse com a idade pedida. */
function semearSlot(idx: number, dono: string, idadeMs: number): void {
  mkdirSync(repo.dirDeSlots, { recursive: true });
  const arquivo = join(repo.dirDeSlots, String(idx));
  writeFileSync(arquivo, dono, 'utf8');
  const quando = new Date(Date.now() - idadeMs);
  utimesSync(arquivo, quando, quando);
}

/** Os arquivos de posse hoje no disco, `<índice> → <dono>`. */
function posseNoDisco(): Map<number, string> {
  const mapa = new Map<number, string>();
  for (const entry of readdirSync(repo.dirDeSlots)) {
    const idx = Number.parseInt(entry, 10);
    if (!Number.isInteger(idx)) continue;
    mapa.set(idx, readFileSync(join(repo.dirDeSlots, entry), 'utf8').trim());
  }
  return mapa;
}

/**
 * A afirmação central, e ela é sobre TODAS as sondas de uma vez: ninguém caiu
 * no caminho nulo, ninguém estourou, e cada root saiu com um db só dele.
 */
function exigirIsolamento(respostas: readonly RespostaDaSonda[], roots: readonly string[]): void {
  for (const [i, r] of respostas.entries()) {
    expect(r.erro ?? '', `sonda ${roots[i]} estourou`).toBe('');
    expect(r.ok, `sonda ${roots[i]} não completou`).toBe(true);
    // O ponto do achado: um caso que aceita `null` não exercita nada.
    expect(r.escopo, `sonda ${roots[i]} caiu no caminho scope === null`).not.toBeNull();
    expect(r.escopo?.root).toBe(roots[i]);
    expect(r.escopo?.commonGitDir).toBe(repo.gitDirComum);
  }

  const dbs = respostas.map((r) => r.escopo?.redisDb);
  expect(new Set(dbs).size, `dbs do Redis repetidos: ${JSON.stringify(dbs)}`).toBe(dbs.length);

  const slugs = respostas.map((r) => r.escopo?.slug);
  expect(new Set(slugs).size, `slugs repetidos: ${JSON.stringify(slugs)}`).toBe(slugs.length);

  const bancos = respostas.map((r) => r.ambiente?.POSTGRES_DB);
  expect(new Set(bancos).size, `bancos repetidos: ${JSON.stringify(bancos)}`).toBe(bancos.length);

  const urls = respostas.map((r) => r.ambiente?.REDIS_URL);
  expect(new Set(urls).size, `URLs de Redis repetidas: ${JSON.stringify(urls)}`).toBe(urls.length);

  // E o disco tem de concordar com o que cada sonda afirmou possuir: um slot
  // cujo conteúdo aponta para outra árvore é posse fantasma.
  const posse = posseNoDisco();
  for (const r of respostas) {
    expect(posse.get(r.escopo?.redisDb ?? -1), `slot ${r.escopo?.redisDb} não nomeia o dono`).toBe(
      r.escopo?.root,
    );
  }
}

describe('#571 — duas rodadas simultâneas em worktrees de verdade', () => {
  it(
    'slot livre: cada árvore sai com banco, ledger e db do Redis próprios',
    async () => {
      const roots = [repo.criarWorktree('wt-a'), repo.criarWorktree('wt-b')];
      const respostas = await rodarSondas(roots);
      exigirIsolamento(respostas, roots);

      // O ledger de migrations mora DENTRO do banco: bancos distintos são
      // ledgers distintos. É esta a metade da #571 que o nome do banco carrega.
      const [a, b] = respostas;
      expect(a.ambiente?.POSTGRES_DB).toMatch(/_wt_wt_a_[0-9a-f]{8}$/);
      expect(b.ambiente?.POSTGRES_DB).toMatch(/_wt_wt_b_[0-9a-f]{8}$/);
      expect(a.ambiente?.DATABASE_URL).not.toBe(b.ambiente?.DATABASE_URL);
    },
    PRAZO,
  );

  it(
    'dono ausente: o slot de uma worktree que sumiu do disco é reciclado',
    async () => {
      semearSlot(1, join(repo.base, 'arvore-que-nao-existe-mais'), 0);
      const roots = [repo.criarWorktree('wt-c')];
      const respostas = await rodarSondas(roots);
      exigirIsolamento(respostas, roots);
      expect(respostas[0].escopo?.redisDb, 'o slot 1 estava livre e devia ter sido reusado').toBe(1);
    },
    PRAZO,
  );

  it(
    'slot stale disputado: N processos, N slots abandonados, N dbs distintos',
    async () => {
      // 6 slots (TEST_REDIS_DATABASES=7 ⇒ índices 1..6) e 6 sondas: toda sonda
      // é OBRIGADA a reciclar, e não sobra folga para uma disputa perdida
      // passar despercebida. Se duas sondas ficarem com o mesmo slot, ou o
      // conjunto de dbs repete, ou alguém estoura por falta de índice.
      const QUANTAS = 12;

      for (let rodada = 0; rodada < 3; rodada++) {
        if (rodada > 0) {
          repo.destruir();
          repo = criarRepoDeSonda();
        }
        const vivaMasParada = join(repo.base, 'parada');
        mkdirSync(vivaMasParada, { recursive: true });

        const roots: string[] = [];
        for (let i = 0; i < QUANTAS; i++) roots.push(repo.criarWorktree(`wt-${rodada}-${i}`));

        for (let idx = 1; idx <= QUANTAS; idx++) {
          // Metade abandonada por sumiço do dono, metade por validade vencida
          // com o dono ainda no disco: os dois motivos de reciclagem entram na
          // mesma disputa.
          const dono = idx % 2 === 0 ? vivaMasParada : join(repo.base, `fantasma-${idx}`);
          semearSlot(idx, dono, 7 * 60 * 60 * 1000);
        }

        // 7 ⇒ índices 1..6. Sem folga: uma disputa perdida vira db repetido ou
        // estouro por falta de slot, e as duas coisas reprovam.
        const respostas = await rodarSondas(roots, { TEST_REDIS_DATABASES: '13' });
        exigirIsolamento(respostas, roots);
        expect(
          new Set(respostas.map((r) => r.escopo?.redisDb)),
          'com 6 slots e 6 sondas a saída tem de ser a permutação de 1..6',
        ).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
      }
    },
    PRAZO,
  );

  it(
    'a base do Redis e do Postgres do AMBIENTE atravessa os processos intacta',
    async () => {
      // Achado da revisão: o setup global limpava um endpoint e os workers
      // usavam outro. Aqui a base customizada entra pelo ambiente e a sonda —
      // outro processo, outra worktree — devolve o que ela USARIA. Só o índice
      // do db e o nome do banco podem mudar.
      const roots = [repo.criarWorktree('wt-x'), repo.criarWorktree('wt-y')];
      const respostas = await rodarSondas(roots, {
        REDIS_URL: 'rediss://cache:s3nh%40@redis.interno:6380/4',
        TEST_DB_URL: 'postgres://outro_user:outra%40senha@pg.interno:5433/base_custom',
      });
      exigirIsolamento(respostas, roots);

      for (const r of respostas) {
        expect(r.ambiente?.REDIS_URL).toBe(
          `rediss://cache:s3nh%40@redis.interno:6380/${r.escopo?.redisDb}`,
        );
        const pg = new URL(r.ambiente?.DATABASE_URL ?? '');
        expect(pg.host).toBe('pg.interno:5433');
        expect(pg.username).toBe('outro_user');
        expect(pg.pathname).toBe(`/base_custom_wt_${r.escopo?.slug}`);
        expect(r.ambiente?.POSTGRES_USER).toBe('outro_user');
        expect(r.ambiente?.POSTGRES_PASSWORD).toBe('outra@senha');
        // As specs de integração afirmam esta igualdade antes de rodar.
        expect(r.ambiente?.TEST_DB_URL).toBe(r.ambiente?.DATABASE_URL);
      }
    },
    PRAZO,
  );
});
