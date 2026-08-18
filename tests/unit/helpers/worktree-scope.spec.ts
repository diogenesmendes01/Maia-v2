/**
 * Issue #571 — o derivador de escopo por worktree.
 *
 * O que este arquivo cobre é a parte PURA (a reescrita das URLs) e a
 * ESTABILIDADE da parte com I/O (a alocação do db do Redis). A prova de que o
 * isolamento funciona de ponta a ponta é comportamental e vive noutro lugar:
 * duas rodadas concorrentes em worktrees diferentes, cada uma só enxergando os
 * próprios dados. Um teste unitário não substitui aquilo — ele impede que
 * alguém quebre a derivação sem perceber.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_REDIS_URL,
  BASE_TEST_DB_URL,
  resolveWorktreeScope,
  scopedDatabaseName,
  scopedDatabaseUrl,
  scopedRedisUrl,
  type WorktreeScope,
} from '../../helpers/worktree-scope.js';

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
