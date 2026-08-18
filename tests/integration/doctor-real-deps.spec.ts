/**
 * `maia doctor` contra Postgres e Redis DE VERDADE (issue #517).
 *
 * O que só um banco real prova, e por isso está aqui e não no unit:
 *
 *   1. **Read-only é imposto pelo SERVIDOR.** O unit prova que
 *      `readOnlyPostgres()` emite `BEGIN READ ONLY`; só o Postgres prova que
 *      isso REJEITA um `INSERT` (SQLSTATE 25006) e que a linha não aparece.
 *      Um teste que reconstruísse o wrapper com um fake passaria com o
 *      `BEGIN READ ONLY` deletado do código de produção.
 *   2. **O caso NEGATIVO de liveness.** Um serviço INALCANÇÁVEL tem de
 *      REPROVAR, não `skip`. Isto aponta o CLI para portas mortas de verdade —
 *      nada mockado — e cobra o exit code.
 *   3. **A independência entre categorias.** Com Postgres morto, os checks de
 *      Redis ainda rodam. É o critério de aceite "uma indisponibilidade não
 *      impede que os demais checks independentes rodem".
 *
 * Todas as rodadas do CLI passam pelo `main()` REAL de `scripts/doctor.ts` —
 * registry, runner, handles e render de verdade. Nada de harness paralelo: um
 * teste que reconstrói o call site passa mesmo com o call site apagado.
 *
 * ### Isolamento
 *
 * O banco de teste é COMPARTILHADO entre worktrees hoje. Por isso este arquivo
 * cria o seu próprio SCHEMA (`maia_doctor_<rand>`), põe a tabela de sonda lá
 * dentro e o derruba no `afterAll`. Nada é contado em tabela do produto: uma
 * asserção sobre `audit_logs` seria flaky por construção com outra worktree
 * escrevendo em paralelo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  doctorPostgresPool,
  readOnlyPostgres,
  READ_ONLY_SQLSTATE,
} from '@/ops/doctor/postgres.js';
import { main } from '../../scripts/doctor.js';

/**
 * Gated on TEST_DB_URL ONLY, como toda spec de banco real aqui. `DATABASE_URL`
 * não serve de fallback: `tests/setup.ts` o define incondicionalmente, então
 * cair nele faria esta suíte TENTAR conectar em qualquer rodada só-unit.
 */
const DB_URL = process.env.TEST_DB_URL;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const d = DB_URL ? describe : describe.skip;

/** Porta sem nada escutando — o alvo do caso negativo. */
const DEAD_PG_PORT = 5433;
const DEAD_REDIS_PORT = 6399;

const SCHEMA = `maia_doctor_${Math.random().toString(36).slice(2, 10)}`;

let admin: pg.Pool;

/** Captura stdout/stderr de uma rodada do CLI e devolve saída + exit code. */
async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string }> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const chunks: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(' '));
  try {
    const code = await main(argv);
    return { code, out: chunks.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

d('maia doctor · dependências reais', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await admin.query(`CREATE TABLE ${SCHEMA}.probe (id TEXT PRIMARY KEY)`);
  }, 30_000);

  afterAll(async () => {
    // Limpa TUDO que criou: o banco é compartilhado entre worktrees.
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  }, 30_000);

  describe('read-only imposto pelo servidor', () => {
    /**
     * O handle pela FÁBRICA DE PRODUÇÃO, a mesma que `scripts/doctor.ts` usa.
     * Montar um pool próprio aqui seria a armadilha do espelho: continuaria
     * provando "um pool read-only recusa escrita" mesmo depois de o CLI parar
     * de construir um.
     */
    function doctorHandle(): { handle: ReturnType<typeof readOnlyPostgres>; pool: pg.Pool } {
      const pool = doctorPostgresPool(DB_URL!);
      return { handle: readOnlyPostgres(pool), pool };
    }

    it('REJEITA INSERT, UPDATE, DELETE e DDL com SQLSTATE 25006', async () => {
      const { handle, pool } = doctorHandle();
      try {
        for (const sql of [
          `INSERT INTO ${SCHEMA}.probe (id) VALUES ('x')`,
          `UPDATE ${SCHEMA}.probe SET id = 'y'`,
          `DELETE FROM ${SCHEMA}.probe`,
          `CREATE TABLE ${SCHEMA}.nope (id TEXT)`,
          `DROP TABLE ${SCHEMA}.probe`,
        ]) {
          await expect(handle.query(sql), sql).rejects.toMatchObject({
            code: READ_ONLY_SQLSTATE,
          });
        }
      } finally {
        await pool.end();
      }
    });

    it('e a tabela continua VAZIA — a rejeição não foi só a mensagem', async () => {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${SCHEMA}.probe`,
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('mas LEITURA funciona pelo mesmo handle', async () => {
      const { handle, pool } = doctorHandle();
      try {
        const rows = await handle.query<{ one: number }>('SELECT 1 AS one');
        expect(rows[0]?.one).toBe(1);
      } finally {
        await pool.end();
      }
    });
  });

  describe('rodada saudável pelo CLI real', () => {
    it('conecta, confirma a transação read-only e lê pgvector, Redis e o veredito de schema', async () => {
      const { code, out } = await runCli(['--online'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      expect(out).toContain('[PASS] postgres.connectivity');
      // A prova, NO CALL SITE DE PRODUÇÃO, de que o wrapper read-only está
      // ligado: se `BEGIN READ ONLY` sumir de readOnlyPostgres(), este check
      // reporta `off` e reprova.
      expect(out).toContain('[PASS] postgres.read_only_session');
      expect(out).toContain('[PASS] postgres.pgvector');
      expect(out).toContain('[PASS] redis.connectivity');
      expect(out).toContain('[PASS] redis.server_version');
      expect(out).not.toContain('[SKIP] postgres.connectivity');
      // O veredito de schema veio do módulo dono (#516), não de heurística: a
      // linha nomeia o head esperado e o aplicado, venha ele pass ou fail.
      expect(out).toMatch(/(\[PASS]|\[FAIL]) postgres\.schema_readiness/);
      expect([0, 1]).toContain(code);
    }, 30_000);

    it('emite JSON versionado e parseável, com run_id novo a cada execução', async () => {
      const first = await runCli(['--online', '--format', 'json', '--only', 'redis'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      const second = await runCli(['--online', '--format', 'json', '--only', 'redis'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      const a = JSON.parse(first.out) as { schema_version: string; run_id: string; checks: unknown[] };
      const b = JSON.parse(second.out) as { run_id: string };
      expect(a.schema_version).toBe('1.0');
      expect(a.checks.length).toBeGreaterThan(0);
      expect(a.run_id).not.toBe(b.run_id);
    }, 30_000);

    it('o modo OFFLINE não abre conexão: todo check de rede vira skip', async () => {
      const { out } = await runCli(['--only', 'postgres,redis'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      expect(out).toContain('[SKIP] postgres.connectivity');
      expect(out).toContain('[SKIP] redis.connectivity');
      expect(out).not.toContain('[PASS] postgres.connectivity');
    }, 30_000);
  });

  describe('caso NEGATIVO de liveness — serviço inalcançável de verdade', () => {
    it('REPROVA (não pula) quando Postgres e Redis não respondem, e sai 1', async () => {
      const { code, out } = await runCli(['--online', '--only', 'postgres,redis'], {
        DATABASE_URL: `postgres://maia_test:test1234@127.0.0.1:${DEAD_PG_PORT}/maia_test`,
        REDIS_URL: `redis://127.0.0.1:${DEAD_REDIS_PORT}`,
      });
      expect(out).toContain('[FAIL] postgres.connectivity');
      expect(out).toContain('Postgres inalcançável');
      expect(out).toContain('[FAIL] redis.connectivity');
      expect(out).toContain('Redis inalcançável');
      // Um `skip` aqui seria o falso sucesso que a issue proíbe.
      expect(out).not.toContain('[SKIP] postgres.connectivity');
      expect(out).not.toContain('[SKIP] redis.connectivity');
      expect(code).toBe(1);
    }, 30_000);

    it('com Postgres morto, os checks de Redis AINDA rodam contra o Redis vivo', async () => {
      const { out } = await runCli(['--online', '--only', 'postgres,redis'], {
        DATABASE_URL: `postgres://maia_test:test1234@127.0.0.1:${DEAD_PG_PORT}/maia_test`,
        REDIS_URL,
      });
      expect(out).toContain('[FAIL] postgres.connectivity');
      expect(out).toContain('[PASS] redis.connectivity');
      expect(out).toContain('[PASS] redis.server_version');
      // Os dependentes do Postgres pulam, e dizem de quem dependiam.
      expect(out).toContain('[SKIP] postgres.pgvector');
      expect(out).toContain('depende de postgres.connectivity');
    }, 30_000);

    it('a mensagem de erro NUNCA carrega a senha do DSN', async () => {
      const { out } = await runCli(['--online', '--only', 'postgres', '--format', 'json'], {
        DATABASE_URL: `postgres://maia_test:senha-canario-canario@127.0.0.1:${DEAD_PG_PORT}/maia_test`,
      });
      expect(out).not.toContain('senha-canario-canario');
      expect(out).toContain('ECONNREFUSED');
    }, 30_000);
  });

  describe('exit codes e uso', () => {
    it('uso inválido sai 2 — "o gate não rodou", nunca confundido com "ambiente ruim"', async () => {
      const { code, out } = await runCli(['--only', 'inexistente'], {});
      expect(code).toBe(2);
      expect(out).toContain('categoria desconhecida');
    });

    it('opção desconhecida sai 2 em vez de ser ignorada em silêncio', async () => {
      // `--tenant` é uma forma que a issue esboça e esta build ainda não
      // implementa. Ignorá-la produziria um verde que não respondeu nada
      // sobre tenant — exatamente o falso sucesso que o doctor existe para
      // não dar.
      const { code, out } = await runCli(['--tenant', 'acme'], {});
      expect(code).toBe(2);
      expect(out).toContain('--tenant');
    });

    it('--strict transforma warning em exit 1', async () => {
      // `redis.persistence` é advisory e, num Redis sem AOF, gera warning.
      const relaxed = await runCli(['--online', '--only', 'redis'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      const strict = await runCli(['--online', '--only', 'redis', '--strict'], {
        DATABASE_URL: DB_URL,
        REDIS_URL,
      });
      if (relaxed.out.includes('[WARN]')) {
        expect(relaxed.code).toBe(0);
        expect(strict.code).toBe(1);
      } else {
        // Redis configurado sem nada a avisar: os dois saem 0, e é correto.
        expect(relaxed.code).toBe(0);
        expect(strict.code).toBe(0);
      }
    }, 30_000);

    it('--skip marca SKIP com aviso visível, nunca sucesso silencioso', async () => {
      const { out } = await runCli(
        ['--online', '--only', 'redis', '--skip', 'redis.persistence'],
        { DATABASE_URL: DB_URL, REDIS_URL },
      );
      expect(out).toContain('[SKIP] redis.persistence');
      expect(out).toContain('DESABILITADO');
    }, 30_000);
  });
});
