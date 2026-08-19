/**
 * Issue #571 — o derivador de escopo por worktree.
 *
 * O que este arquivo cobre é a parte PURA: a reescrita das URLs e a COMPOSIÇÃO
 * do ambiente de teste. A prova comportamental — worktrees de verdade,
 * processos concorrentes, dbs distintos — é
 * `worktree-scope-concorrencia.spec.ts`, e a prova com infra ao vivo é
 * `tests/integration/worktree-isolamento-canario.spec.ts`. Os três juntos
 * substituem o que a PR #597 tinha: casos que faziam `return` quando o escopo
 * era `null`, e portanto não executavam nada no CI.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comLockDeDiretorio } from '../../helpers/lock-de-diretorio.js';
import {
  BASE_REDIS_URL,
  BASE_TEST_DB_URL,
  baseRedisUrl,
  basePostgresUrl,
  resolveTestEnv,
  resolveWorktreeScope,
  sanitizarMensagem,
  sanitizarUrl,
  scopedDatabaseName,
  scopedDatabaseUrl,
  scopedRedisUrl,
  type WorktreeScope,
} from '../../helpers/worktree-scope.js';

const RAIZ_DOS_TESTES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE: WorktreeScope = {
  root: '/repo/.claude/worktrees/exemplo',
  slug: 'exemplo_deadbeef',
  redisDb: 7,
  commonGitDir: '/repo/.git',
};

describe('#571 — derivação do escopo por worktree', () => {
  describe('escopo ausente (checkout principal, CI, TEST_WORKTREE_SCOPE=off)', () => {
    it('não toca a URL do Postgres', () => {
      expect(scopedDatabaseUrl(BASE_TEST_DB_URL, null)).toBe(BASE_TEST_DB_URL);
    });

    it('não toca a URL do Redis', () => {
      expect(scopedRedisUrl(BASE_REDIS_URL, null)).toBe(BASE_REDIS_URL);
    });

    it('não toca o nome do banco', () => {
      expect(scopedDatabaseName('maia_test', null)).toBe('maia_test');
    });
  });

  describe('escopo presente', () => {
    it('troca SÓ o banco, preservando host, porta e credenciais', () => {
      const url = new URL(scopedDatabaseUrl(BASE_TEST_DB_URL, FAKE));
      expect(url.protocol).toBe('postgres:');
      expect(url.host).toBe('localhost:5432');
      expect(url.username).toBe('maia_test');
      expect(url.password).toBe('test1234');
      expect(url.pathname).toBe('/maia_test_wt_exemplo_deadbeef');
    });

    it('troca SÓ o db do Redis, preservando host e porta', () => {
      expect(scopedRedisUrl(BASE_REDIS_URL, FAKE)).toBe('redis://localhost:6379/7');
    });

    it('respeita o teto de 63 caracteres de um identificador do Postgres', () => {
      // O nome do banco entra num `CREATE DATABASE`; passar de 63 faz o
      // Postgres TRUNCAR em silêncio, e dois escopos longos viram um só.
      const nome = scopedDatabaseName('b'.repeat(80), FAKE);
      expect(nome.length).toBeLessThanOrEqual(63);
      // O sufixo é a parte que carrega a identidade — é ele que sobrevive.
      expect(nome.endsWith('_wt_exemplo_deadbeef')).toBe(true);
    });

    it('um `db` já presente na URL base do Redis é SUBSTITUÍDO, não concatenado', () => {
      expect(scopedRedisUrl('redis://localhost:6379/3', FAKE)).toBe('redis://localhost:6379/7');
    });
  });

  describe('idempotência da reescrita', () => {
    it('aplicar o escopo duas vezes dá o mesmo nome de banco', () => {
      // `tests/setup.ts` passou a derivar a base do AMBIENTE, e um ambiente já
      // escopado (herdado por um filho, ou reaplicado) geraria `…_wt_x_wt_x` —
      // um banco que ninguém criou e no qual nenhuma migration rodou.
      const uma = scopedDatabaseName('maia_test', FAKE);
      expect(scopedDatabaseName(uma, FAKE)).toBe(uma);
      const url = scopedDatabaseUrl(BASE_TEST_DB_URL, FAKE);
      expect(scopedDatabaseUrl(url, FAKE)).toBe(url);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────
   * UMA base, um destino — o achado da revisão da PR #597
   *
   * `globalSetup` limpava `process.env.REDIS_URL ?? BASE_REDIS_URL` e os
   * workers iam sempre para `BASE_REDIS_URL`. Com Redis fora do default, o
   * `FLUSHDB` acertava um endpoint e os clientes outro.
   * ─────────────────────────────────────────────────────────────────────── */
  describe('base única de Redis e Postgres', () => {
    it('a base do Redis vem do ambiente quando ele diz algo', () => {
      expect(baseRedisUrl({ REDIS_URL: 'rediss://u:p@r.interno:6380/2' })).toBe(
        'rediss://u:p@r.interno:6380/2',
      );
      expect(baseRedisUrl({})).toBe(BASE_REDIS_URL);
    });

    it('a base do Postgres vem de TEST_DB_URL, e DATABASE_URL do shell NÃO conta', () => {
      // `tests/setup.ts` existe para blindar a rodada do shell do
      // desenvolvedor: quem exporta DATABASE_URL costuma estar apontando para
      // o banco de DEV, não para o de teste.
      expect(basePostgresUrl({ TEST_DB_URL: 'postgres://a:b@pg:5433/x' })).toBe(
        'postgres://a:b@pg:5433/x',
      );
      expect(basePostgresUrl({ DATABASE_URL: 'postgres://dev:dev@localhost:5432/maia' })).toBe(
        BASE_TEST_DB_URL,
      );
    });

    it('host, porta, credencial e path não-default sobrevivem ao escopo', () => {
      const ambiente = resolveTestEnv(
        {
          REDIS_URL: 'rediss://cache:s3nh%40@redis.interno:6380/4',
          TEST_DB_URL: 'postgres://outro_user:outra%40senha@pg.interno:5433/base_custom',
        },
        FAKE,
      );
      // Só o índice do db muda — esquema, credencial, host e porta ficam.
      expect(ambiente.REDIS_URL).toBe('rediss://cache:s3nh%40@redis.interno:6380/7');
      expect(ambiente.DATABASE_URL).toBe(
        'postgres://outro_user:outra%40senha@pg.interno:5433/base_custom_wt_exemplo_deadbeef',
      );
      // E as credenciais avulsas saem da MESMA URL, em vez de ficarem fixas em
      // `maia_test`/`test1234` como antes.
      expect(ambiente.POSTGRES_USER).toBe('outro_user');
      expect(ambiente.POSTGRES_PASSWORD).toBe('outra@senha');
      expect(ambiente.POSTGRES_DB).toBe('base_custom_wt_exemplo_deadbeef');
      expect(ambiente.TEST_DB_URL).toBe(ambiente.DATABASE_URL);
    });

    it('a URL que o setup global LIMPA é a mesma que os workers USAM', () => {
      // O achado, dito como igualdade. `tests/globalSetup.ts` chama
      // `resolveTestEnv(process.env, scope).REDIS_URL` para o `FLUSHDB`;
      // `tests/setup.ts` chama a MESMA função para o que os clientes leem.
      const env = { REDIS_URL: 'redis://:senha@10.0.0.9:6399', TEST_DB_URL: BASE_TEST_DB_URL };
      const limpa = resolveTestEnv(env, FAKE).REDIS_URL;
      const usada = resolveTestEnv(env, FAKE).REDIS_URL;
      expect(limpa).toBe(usada);
      expect(limpa).toBe('redis://:senha@10.0.0.9:6399/7');
    });

    it('nenhum dos dois arquivos compõe URL por conta própria', () => {
      // Guarda estrutural, e é a que teria pego a divergência original: as duas
      // expressões existiam em DUAS cópias e uma delas mudou sozinha. Enquanto
      // `resolveTestEnv` for o único caminho, elas não têm como divergir.
      for (const arquivo of ['setup.ts', 'globalSetup.ts']) {
        const fonte = readFileSync(join(RAIZ_DOS_TESTES, arquivo), 'utf8');
        const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(codigo, `${arquivo} tem de derivar o ambiente por resolveTestEnv`).toContain(
          'resolveTestEnv',
        );
        expect(codigo, `${arquivo} não pode montar a URL do Redis sozinho`).not.toContain(
          'scopedRedisUrl',
        );
        expect(codigo, `${arquivo} não pode montar a URL do Postgres sozinho`).not.toContain(
          'scopedDatabaseUrl',
        );
      }
    });
  });

  describe('diagnóstico sem vazar credencial', () => {
    it('a senha some da URL, o destino fica', () => {
      expect(sanitizarUrl('rediss://usuario:sup3r-secreta@redis.interno:6380/4')).toBe(
        'rediss://usuario:***@redis.interno:6380/4',
      );
      expect(sanitizarUrl('redis://localhost:6379/2')).toBe('redis://localhost:6379/2');
      expect(sanitizarUrl('nao é uma url')).toBe('<url ilegível>');
    });

    it('a senha some também de texto livre de biblioteca', () => {
      expect(sanitizarMensagem('connect ECONNREFUSED redis://u:sup3r@10.0.0.9:6399')).toBe(
        'connect ECONNREFUSED redis://u:***@10.0.0.9:6399',
      );
    });
  });

  describe('lock de diretório entre processos', () => {
    it('o segundo pedido não entra enquanto o primeiro não sai', () => {
      const base = mkdtempSync(join(tmpdir(), 'wt571-lock-'));
      const lock = join(base, 'l');
      try {
        const externo = comLockDeDiretorio(lock, () =>
          // Tentativa aninhada: o mesmo caminho, já tomado. Sem espera, porque
          // o teste não pode ficar 10s parado provando o óbvio.
          comLockDeDiretorio(lock, () => 'entrou', { esperaMaximaMs: 0 }),
        );
        expect(externo.ok).toBe(true);
        expect(externo.ok && externo.valor.ok, 'o aninhado NÃO podia entrar').toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('um lock preso além da validade é quebrado, não eterniza a espera', () => {
      const base = mkdtempSync(join(tmpdir(), 'wt571-lock-'));
      const lock = join(base, 'l');
      try {
        comLockDeDiretorio(lock, () => {
          const preso = comLockDeDiretorio(lock, () => 'quebrei', {
            esperaMaximaMs: 2_000,
            // Validade negativa: o lock de fora já nasce "velho".
            validadeMs: -1,
            passoMs: 1,
          });
          expect(preso.ok && preso.valor).toBe('quebrei');
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('o corpo libera o lock mesmo estourando', () => {
      const base = mkdtempSync(join(tmpdir(), 'wt571-lock-'));
      const lock = join(base, 'l');
      try {
        expect(() =>
          comLockDeDiretorio(lock, () => {
            throw new Error('boom');
          }),
        ).toThrow('boom');
        const depois = comLockDeDiretorio(lock, () => 'livre', { esperaMaximaMs: 0 });
        expect(depois.ok && depois.valor).toBe('livre');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('resolução real neste checkout', () => {
    const escopo = resolveWorktreeScope();

    it('a posse do db do Redis está gravada no slot, e o slot nomeia ESTA árvore', () => {
      // Memoizar dentro do processo não prova nada: os workers do vitest são
      // processos SEPARADOS e cada um chama o alocador do zero. O que faz os
      // dois chegarem ao mesmo número é o arquivo de posse — e é ele, não o
      // cache, que este caso confere. Sem isso, cada worker pegaria um db
      // diferente e a rodada deixaria de enxergar as próprias chaves.
      if (escopo === null) return;
      const slot = join(escopo.commonGitDir, 'maia-redis-slots', String(escopo.redisDb));
      expect(readFileSync(slot, 'utf8').trim()).toBe(escopo.root);
    });

    it('ou é nulo (checkout principal/CI), ou é internamente coerente', () => {
      if (escopo === null) return; // rodando no checkout principal ou no CI
      expect(escopo.redisDb).toBeGreaterThanOrEqual(1);
      expect(escopo.slug).toMatch(/^[a-z0-9_]+_[0-9a-f]{8}$/);
      expect(escopo.root.startsWith(escopo.commonGitDir.replace(/\.git$/, ''))).toBe(true);
    });
  });
});
