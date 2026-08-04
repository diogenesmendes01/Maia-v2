/**
 * Migration CLI — a THIN adapter over `src/migrations/` (issue #516).
 *
 * All the logic (discovery, checksums, advisory lock, ledger, dirty state,
 * readiness) lives in the library so the init job, the tests and `maia doctor`
 * (#517) share exactly one implementation. This file only does the three things
 * a CLI is allowed to do: parse argv, print, and choose an exit code.
 *
 * ```bash
 * npm run db:migrate                 # = `up`
 * tsx scripts/migrate.ts plan        # read-only: what would be applied
 * tsx scripts/migrate.ts status      # read-only: full ledger vs artifact
 * tsx scripts/migrate.ts up
 * tsx scripts/migrate.ts repair --id <migration.sql> --as applied|pending --reason "..."
 * ```
 *
 * `plan` and `status` NEVER write (no DDL, no backfill, no lock). `repair` is
 * an exceptional, audited operation — see `docs/runbooks/migrations.md`.
 *
 * Exit codes: 0 success / up-to-date · 1 failure, blocked, or lock unavailable.
 * `process.exit()` is called HERE and never inside the library.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadMigrationConfig } from '@/config/migration-config.js';
import { ConfigValidationError } from '@/config/load.js';
import {
  getSchemaReadiness,
  repairMigration,
  runMigrations,
  shortChecksum,
  type MigrationRunResult,
  type MigrationStatusReport,
  type RunnerDeps,
} from '@/migrations/index.js';

/**
 * Re-exported for backwards compatibility: `tests/unit/scripts/migrate-no-tx-split.spec.ts`
 * (PR #310) pins these against the real migration files. The implementations
 * moved to `src/migrations/discover.ts`; the behaviour is unchanged.
 */
export { NO_TX_MARKER, splitNoTxStatements } from '@/migrations/discover.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Structured log line. Only ids, short checksums, durations, error classes. */
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...detail }));
}

async function readAppVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function printStatus(status: MigrationStatusReport): void {
  console.log(
    `ledger: ${status.ledger_present ? `v${status.ledger_version}` : 'ABSENT'} · ` +
      `expected head: ${status.expected_head ?? 'none'} · applied head: ${status.applied_head ?? 'none'}`,
  );
  const c = status.counts;
  console.log(
    `total ${c.total} · applied ${c.applied} · pending ${c.pending} · dirty ${c.dirty} · ` +
      `failed ${c.failed} · running ${c.running} · orphaned ${c.orphaned_running} · ` +
      `mismatch ${c.checksum_mismatch} · unknown-checksum ${c.checksum_unknown} · missing ${c.missing_file}`,
  );
  for (const entry of status.entries) {
    if (entry.state === 'applied') continue;
    console.log(
      `  [${entry.state}] ${entry.id} (artifact ${shortChecksum(entry.checksum)} / ledger ${shortChecksum(entry.ledger_checksum)})`,
    );
  }
  for (const id of status.out_of_order) {
    console.log(`  [out-of-order] ${id} sorts before the applied head — merged from an older branch`);
  }
  for (const problem of status.problems) {
    console.log(`  [artifact] ${problem.kind}: ${problem.detail}`);
  }
}

function printRunResult(result: MigrationRunResult): void {
  for (const id of result.applied) console.log(`  applied ${id}`);
  for (const blocker of result.blockers) console.error(`  BLOCKED ${blocker.kind}: ${blocker.detail}`);
  console.log(
    `outcome: ${result.outcome} · applied ${result.applied.length} · ` +
      `backfilled ${result.backfilled.length} · orphaned→dirty ${result.orphaned.length} · ` +
      `lock wait ${result.lock_waited_ms}ms`,
  );
}

function flagValue(argv: readonly string[], name: string): string | null {
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] ?? null;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(`--${name}=`.length) : null;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'up';
  const config = loadMigrationConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const deps: RunnerDeps = {
    pool,
    migrationsDir: MIGRATIONS_DIR,
    onEvent: emit,
    appVersion: await readAppVersion(),
  };

  try {
    switch (command) {
      case 'plan':
      case 'status': {
        // One read-only round trip. `getSchemaReadiness` never throws, so an
        // unreachable database prints a verdict instead of a stack trace.
        const readiness = await getSchemaReadiness({ pool, migrationsDir: MIGRATIONS_DIR });
        const status = readiness.status;
        if (status) printStatus(status);
        if (command === 'plan') {
          console.log(
            !status
              ? 'plan: unavailable — the applied schema could not be read'
              : status.pending.length === 0
                ? 'plan: nothing to apply'
                : `plan: would apply ${status.pending.length} migration(s):\n  ${status.pending.join('\n  ')}`,
          );
        }
        console.log(`readiness: ${readiness.state}${readiness.reason ? ` — ${readiness.reason}` : ''}`);
        for (const blocker of readiness.blockers) {
          console.error(`  BLOCKER ${blocker.kind}: ${blocker.detail}`);
        }
        // Pending work is NOT an error for a read-only command — that is what
        // `up` is for. A blocked entry (dirty, checksum mismatch, missing file),
        // a broken artifact, or an unreadable schema IS, so CI can gate on
        // `migrate status`.
        const broken =
          status === null || status.entries.some((e) => e.blocking) || status.problems.length > 0;
        return broken ? 1 : 0;
      }

      case 'repair': {
        const id = flagValue(argv, 'id');
        const reason = flagValue(argv, 'reason');
        const as = flagValue(argv, 'as') ?? 'applied';
        if (!id || !reason) {
          console.error('repair requires --id <migration.sql> --reason "<why>" [--as applied|pending]');
          return 1;
        }
        if (as !== 'applied' && as !== 'pending') {
          console.error('--as must be "applied" (schema verified in place) or "pending" (partial change undone)');
          return 1;
        }
        const result = await repairMigration(deps, { id, outcome: as, reason });
        if (!result.ok) {
          console.error(`repair refused: ${result.reason}`);
          return 1;
        }
        console.log(`repaired ${result.id} -> ${result.outcome}`);
        return 0;
      }

      case 'up': {
        const result = await runMigrations(deps);
        printRunResult(result);
        return result.ok ? 0 : 1;
      }

      default:
        console.error(`unknown command "${command}" — expected one of: up, plan, status, repair`);
        return 1;
    }
  } finally {
    // Closes on BOTH the success and the failure path (issue #516: "`maia
    // migrate up` fecha conexões em sucesso e falha").
    await pool.end().catch(() => undefined);
  }
}

/**
 * Only run `main()` when this file is the process entrypoint — NOT when a test
 * imports it to exercise the pure helpers. `import.meta.url` is a `file://`
 * URL; argv[1] is a filesystem path, normalised via `pathToFileURL` so the
 * comparison holds on Windows (`file:///C:/...`) and POSIX alike.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.MIGRATE_NO_MAIN) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // `ConfigValidationError` é a ÚNICA exceção à redaction, e é deliberada:
      // sua mensagem é construída só com nome de variável, regra e remediação —
      // nunca com o VALOR lido (`src/config/load.ts:59-68`), e é exatamente o
      // formato que `npm run config:check` já imprime. Engoli-la transformava a
      // falha mais provável do runner ("faltou POSTGRES_USER") em
      // `unexpected failure (ConfigValidationError)`, que não diz o que fazer —
      // desperdiçando o diagnóstico acionável que o contrato da #515 existe
      // para dar.
      if (err instanceof ConfigValidationError) {
        console.error(`migrate: ${err.message}`);
        process.exitCode = 2;
        return;
      }
      // Para todo o resto, CLASSE apenas — a mensagem de um erro do pg embute a
      // connection string com senha.
      const cls =
        typeof (err as { code?: unknown } | null)?.code === 'string'
          ? String((err as { code: string }).code)
          : err instanceof Error
            ? err.constructor.name
            : 'UnknownError';
      console.error(`migrate: unexpected failure (${cls})`);
      process.exitCode = 1;
    },
  );
}
