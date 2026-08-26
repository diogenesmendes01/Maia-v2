/**
 * Issue #516 (resíduo) — os tetos de lock/statement saem do CONTRATO, não de
 * constante de módulo.
 *
 * `DEFAULT_LOCK_WAIT_MS` / `DEFAULT_LOCK_POLL_MS` (`src/migrations/lock.ts`) e
 * `DEFAULT_STATEMENT_LOCK_TIMEOUT_MS` (`src/migrations/runner.ts`) continuam
 * existindo — são o default da BIBLIOTECA, que nunca lê `process.env`. O que
 * muda é que o único caminho de PRODUÇÃO que roda migrations,
 * `scripts/migrate.ts`, passa a injetar os valores do contrato (#515).
 *
 * ## Por que o teste roda o `main()` de verdade
 *
 * Um teste que chamasse `migrationRunOptions(config)` e conferisse o objeto
 * devolvido passaria com a linha de `scripts/migrate.ts` deletada — a armadilha
 * do espelho. O que precisa ficar vermelho é o CALL SITE: `runMigrations` é
 * mockado e o teste afirma o SEGUNDO argumento que a CLI realmente lhe entrega.
 * Apague `migrationRunOptions(config)` de `scripts/migrate.ts` e o caso abaixo
 * reprova com `undefined`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MigrationRunResult, RunOptions } from '@/migrations/index.js';

const runMigrationsMock = vi.fn<(deps: unknown, options?: RunOptions) => Promise<MigrationRunResult>>();

vi.mock('@/migrations/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/migrations/index.js')>();
  return { ...actual, runMigrations: runMigrationsMock };
});

/**
 * `pg.Pool` nunca conecta neste teste (o runner está mockado), mas o construtor
 * real cria timers de pool. Um stub mantém o caso puro e rápido.
 */
vi.mock('pg', () => {
  class Pool {
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { default: { Pool }, Pool };
});

const OK: MigrationRunResult = {
  ok: true,
  outcome: 'up_to_date',
  applied: [],
  backfilled: [],
  orphaned: [],
  blockers: [],
  status: null,
  lock_waited_ms: 0,
};

/** Ambiente MÍNIMO que satisfaz o serviço `migrator` do contrato. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  MAIA_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'senha1234',
  POSTGRES_DB: 'd',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
  runMigrationsMock.mockReset();
  runMigrationsMock.mockResolvedValue(OK);
});

afterEach(() => {
  process.env = savedEnv;
  vi.unstubAllGlobals();
});

/** Roda `migrate up` com o ambiente dado e devolve as opções que a CLI passou. */
async function optionsPassedByCli(over: Record<string, string> = {}): Promise<RunOptions | undefined> {
  process.env = { ...BASE_ENV, ...over, MIGRATE_NO_MAIN: '1' } as NodeJS.ProcessEnv;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { main } = await import('../../../scripts/migrate.js');
    const code = await main(['up']);
    expect(code, 'a CLI não completou o comando `up`').toBe(0);
  } finally {
    log.mockRestore();
  }
  expect(runMigrationsMock, 'a CLI não chamou runMigrations').toHaveBeenCalledTimes(1);
  return runMigrationsMock.mock.calls[0]?.[1];
}

describe('scripts/migrate.ts — os tetos vêm do contrato', () => {
  it('injeta os DEFAULTS do contrato, que são os valores anteriores (sem mudar comportamento)', async () => {
    const options = await optionsPassedByCli();
    expect(options).toEqual({
      waitMs: 30_000,
      pollMs: 500,
      lockTimeoutMs: 10_000,
      // `0` no contrato = SEM teto; o runner expressa isso como `null`.
      statementTimeoutMs: null,
    });
  });

  it('honra o que o operador configurou — é isto que uma constante de módulo não permitia', async () => {
    const options = await optionsPassedByCli({
      MIGRATION_LOCK_WAIT_MS: '90000',
      MIGRATION_LOCK_POLL_MS: '250',
      MIGRATION_LOCK_TIMEOUT_MS: '3000',
      MIGRATION_STATEMENT_TIMEOUT_MS: '900000',
    });
    expect(options).toEqual({
      waitMs: 90_000,
      pollMs: 250,
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 900_000,
    });
  });

  it('`MIGRATION_LOCK_TIMEOUT_MS=0` desliga o teto (fail-open explícito), não vira 0ms', async () => {
    // A distinção importa: `SET lock_timeout = 0` é "sem limite" no Postgres.
    // Traduzir para `null` mantém o TIPO dizendo o que a configuração quer,
    // em vez de exigir que o leitor conheça a semântica do `SET`.
    const options = await optionsPassedByCli({ MIGRATION_LOCK_TIMEOUT_MS: '0' });
    expect(options?.lockTimeoutMs).toBeNull();
  });

  it('recusa o boot do migrator com teto negativo, em vez de aceitar e ignorar', async () => {
    process.env = { ...BASE_ENV, MIGRATION_LOCK_WAIT_MS: '-1', MIGRATE_NO_MAIN: '1' } as NodeJS.ProcessEnv;
    const { main } = await import('../../../scripts/migrate.js');
    await expect(main(['up'])).rejects.toThrow(/MIGRATION_LOCK_WAIT_MS/);
    expect(runMigrationsMock, 'nada pode ser aplicado com configuração inválida').not.toHaveBeenCalled();
  });
});
