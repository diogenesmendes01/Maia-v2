/**
 * Issue #733 — `migrate up` refuses a broken artifact BEFORE touching the
 * database.
 *
 * The guard itself lives in discovery (`buildMigrationArtifact`, pure). What
 * this spec pins is the CALL SITE: `scripts/migrate.ts up` reads the artifact
 * from disk first and, when it carries a problem, prints the blockers and
 * exits 1 without calling `runMigrations` — which is what takes the advisory
 * lock, i.e. the first connection. The runner still re-checks the same
 * problems under the lock (`applyUnderLock`), pinned by
 * `tests/unit/migrations/runner.spec.ts`; this is the front door.
 *
 * `runMigrations` and `discoverMigrations` are mocked at the module the CLI
 * imports from, so the test observes what the CLI actually does with them.
 * `pg.Pool` is stubbed with a class that FAILS on any attempt to connect or
 * query: the CLI constructs the pool up front (node-postgres connects
 * lazily), so "no connection" is asserted as "no call", not assumed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MigrationArtifact, MigrationRunResult, RunOptions } from '@/migrations/index.js';
import { buildMigrationArtifact } from '@/migrations/discover.js';

const runMigrationsMock =
  vi.fn<(deps: unknown, options?: RunOptions) => Promise<MigrationRunResult>>();
const discoverMigrationsMock = vi.fn<(dir: string) => Promise<MigrationArtifact>>();

vi.mock('@/migrations/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/migrations/index.js')>();
  return { ...actual, runMigrations: runMigrationsMock, discoverMigrations: discoverMigrationsMock };
});

const poolTouched = vi.fn<(method: string) => void>();

vi.mock('pg', () => {
  class Pool {
    connect(): Promise<never> {
      poolTouched('connect');
      return Promise.reject(new Error('this test allows no connection'));
    }
    query(): Promise<never> {
      poolTouched('query');
      return Promise.reject(new Error('this test allows no connection'));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { default: { Pool }, Pool };
});

const UP_TO_DATE: MigrationRunResult = {
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

/** The issue's own example — a dollar-quoted body under the marker. */
const DOLLAR_BODY_UNDER_MARKER = [
  '-- maia:no-transaction',
  'DO $meu_bloco$',
  'BEGIN',
  "  RAISE EXCEPTION 'algo';",
  'END',
  '$meu_bloco$;',
  '',
].join('\n');

function artifactOf(contents: string): MigrationArtifact {
  return buildMigrationArtifact([{ filename: '900_x.sql', contents }], ['900_x_down.sql']);
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
  process.env = { ...BASE_ENV, MIGRATE_NO_MAIN: '1' } as NodeJS.ProcessEnv;
  runMigrationsMock.mockReset();
  runMigrationsMock.mockResolvedValue(UP_TO_DATE);
  discoverMigrationsMock.mockReset();
  poolTouched.mockReset();
});

afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
});

async function runUp(): Promise<{ code: number; stderr: string[]; stdout: string[] }> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const { main } = await import('../../../scripts/migrate.js');
  const code = await main(['up']);
  return { code, stderr, stdout };
}

describe('scripts/migrate.ts up — artifact pre-flight (#733)', () => {
  it('refuses a no-transaction file with a dollar-quoted body before the runner, the lock or any connection — and runs the same file without the marker', async () => {
    // The refusal.
    const broken = artifactOf(DOLLAR_BODY_UNDER_MARKER);
    expect(broken.problems.map((p) => p.kind), 'fixture sanity').toEqual([
      'no_transaction_unsplittable',
    ]);
    discoverMigrationsMock.mockResolvedValueOnce(broken);

    const refused = await runUp();

    expect(refused.code).toBe(1);
    expect(runMigrationsMock, 'the runner (and with it the lock) must not be reached').not.toHaveBeenCalled();
    expect(poolTouched, 'no connection, no query').not.toHaveBeenCalled();
    const blocked = refused.stderr.find((line) => line.includes('BLOCKED artifact_integrity'));
    expect(blocked).toBeDefined();
    expect(blocked).toContain('900_x.sql');
    expect(blocked).toContain('maia:no-transaction');
    expect(blocked).toContain('$meu_bloco$');
    expect(refused.stdout.some((line) => line.includes('"event":"migration.blocked"'))).toBe(true);
    expect(refused.stdout.some((line) => line.startsWith('outcome: blocked'))).toBe(true);

    // CONTROL, same `it`: the identical file WITHOUT the marker is a clean
    // artifact, the pre-flight lets it through and the runner is called once
    // with the pool. A pre-flight that "always refuses" fails here.
    const clean = artifactOf(DOLLAR_BODY_UNDER_MARKER.split('\n').slice(1).join('\n'));
    expect(clean.problems, 'control fixture sanity').toEqual([]);
    discoverMigrationsMock.mockResolvedValueOnce(clean);

    const accepted = await runUp();

    expect(accepted.code).toBe(0);
    expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    expect(accepted.stderr).toEqual([]);
  });
});
