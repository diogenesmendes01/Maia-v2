#!/usr/bin/env tsx
/**
 * `maia` — operator CLI (issue #516; extended by `maia doctor` in #517).
 *
 *   maia migrate check                     # OFFLINE artifact check (no DB)
 *   maia migrate manifest [--json]         # release schema manifest
 *   maia migrate plan    [--json]          # read-only: what WOULD be applied
 *   maia migrate status  [--json]          # read-only: full ledger state
 *   maia migrate up      [--json]          # apply, serialised by advisory lock
 *   maia migrate repair --id <id> --resolution applied|pending \
 *                       --reason "<why>" --actor "<who>" --yes
 *
 * EXIT CODES (stable — CI and the deploy job switch on them):
 *   0  success / nothing to do
 *   1  unexpected error (bug, unreachable database, invalid configuration)
 *   2  refused: schema drift an operator has to resolve
 *   3  another migrator holds the lock and did not release it in time
 *   4  a migration failed (or left dirty state)
 *
 * `plan`, `status`, `check` and `manifest` NEVER write to the database.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { defaultMigrationsDir, discoverMigrations } from '@/migrations/discover.js';
import { buildSchemaManifest } from '@/migrations/manifest.js';
import { migrateUp, planMigrations, repairMigration } from '@/migrations/runner.js';
import { withMigrationRunner } from '@/migrations/bootstrap.js';
import { BLOCKS_UP, type Drift } from '@/migrations/types.js';
import { describeError } from '@/migrations/log.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DRIFT = 2;
export const EXIT_LOCKED = 3;
export const EXIT_FAILED = 4;

const USAGE = `maia migrate <command>

  check                     validate the migration artifact (no database)
  manifest [--json]         print this release's schema manifest
  plan     [--json]         read-only: pending migrations + drift
  status   [--json]         read-only: full ledger state
  up       [--json]         apply pending migrations (advisory-locked)
  repair   --id <id> --resolution applied|pending --reason "<why>" --actor "<who>" --yes

Exit codes: 0 ok · 1 error · 2 drift · 3 lock timeout · 4 migration failed`;

interface Flags {
  readonly positional: string[];
  readonly named: Record<string, string | boolean>;
}

/** Minimal `--flag` / `--flag=value` / `--flag value` parser. Pure. */
export function parseArgs(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const named: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      named[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      named[body] = next;
      i += 1;
    } else {
      named[body] = true;
    }
  }
  return { positional, named };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function formatProblems(problems: readonly Drift[]): string {
  return problems.map((p) => `  [${p.severity}] ${p.code}: ${p.detail}`).join('\n');
}

/** `maia migrate check` — artifact-only. Runs in CI with no `DATABASE_URL`. */
export function cmdCheck(asJson: boolean, dir = defaultMigrationsDir()): number {
  const migrations = discoverMigrations(dir);
  const problems: string[] = [];

  for (const m of migrations) {
    if (m.prefix === null) problems.push(`${m.id}: filename has no conforming numeric prefix`);
    if (m.downId === null) problems.push(`${m.id}: missing its _down.sql sibling (AGENTS.md §4.6)`);
  }
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) problems.push(`${m.id}: duplicate filename`);
    seen.add(m.id);
  }

  if (asJson) {
    json({ ok: problems.length === 0, migration_count: migrations.length, problems });
  } else if (problems.length === 0) {
    out(`migrate check passed: ${migrations.length} forward migration(s), every one with a _down sibling.`);
  } else {
    err(`migrate check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return problems.length === 0 ? EXIT_OK : EXIT_DRIFT;
}

/** `maia migrate manifest` — the release's schema statement. No database. */
export function cmdManifest(
  asJson: boolean,
  range: { minSupported?: string | null; maxSupported?: string | null } = {},
  dir = defaultMigrationsDir(),
): number {
  const manifest = buildSchemaManifest(discoverMigrations(dir), range);
  if (asJson) {
    json(manifest);
  } else {
    out(`schema_manifest_version : ${manifest.schema_manifest_version}`);
    out(`runner_version          : ${manifest.runner_version}`);
    out(`expected_head           : ${manifest.expected_head ?? '(none)'}`);
    out(`min_supported_migration : ${manifest.min_supported_migration ?? '(none)'}`);
    out(`max_supported_migration : ${manifest.max_supported_migration ?? '(unbounded)'}`);
    out(`migration_count         : ${manifest.migration_count}`);
  }
  return EXIT_OK;
}

async function cmdPlan(asJson: boolean, full: boolean): Promise<number> {
  return withMigrationRunner(async (options) => {
    const plan = await planMigrations(options);
    const { compatibility: compat } = plan;
    if (asJson) {
      json(full ? plan : { ...plan, migrations: plan.migrations.filter((m) => m.state !== 'applied') });
      return compat.problems.some((p) => BLOCKS_UP.has(p.code)) ? EXIT_DRIFT : EXIT_OK;
    }

    out(`ledger        : ${plan.ledger_exists ? 'present' : 'ABSENT (virgin database)'}`);
    out(`head expected : ${compat.expected_head ?? '(none)'}`);
    out(`head applied  : ${compat.applied_head ?? '(none)'}`);
    out(
      `counters      : ${compat.counters.applied_count} applied · ` +
        `${compat.counters.pending_count} pending · ${compat.counters.dirty_count} dirty · ` +
        `${compat.counters.failed_count} failed · ${compat.counters.mismatch_count} checksum mismatch`,
    );
    if (compat.pending.length > 0) {
      out('');
      out('pending (in apply order):');
      for (const id of compat.pending) {
        const entry = plan.migrations.find((m) => m.id === id);
        out(
          `  ${id}  ${entry ? entry.checksum_short : '?'}` +
            `${entry?.no_transaction ? '  [no-tx]' : ''}${entry?.state !== 'pending' ? `  [${entry?.state}]` : ''}`,
        );
      }
    }
    if (full) {
      out('');
      out('every migration:');
      for (const m of plan.migrations) {
        out(`  ${m.state.padEnd(8)} ${m.id}  ${m.checksum_short}${m.no_transaction ? '  [no-tx]' : ''}`);
      }
    }
    if (compat.problems.length > 0) {
      out('');
      out('problems:');
      out(formatProblems(compat.problems));
    }
    return compat.problems.some((p) => BLOCKS_UP.has(p.code)) ? EXIT_DRIFT : EXIT_OK;
  });
}

async function cmdUp(asJson: boolean): Promise<number> {
  return withMigrationRunner(async (options) => {
    const result = await migrateUp(options);
    if (asJson) json(result);

    switch (result.outcome) {
      case 'applied':
        if (!asJson) {
          out(`applied ${result.applied.length} migration(s); head is now ${result.head ?? '(none)'}.`);
        }
        return EXIT_OK;
      case 'noop':
        if (!asJson) out(`nothing to apply; head is ${result.head ?? '(none)'}.`);
        return EXIT_OK;
      case 'blocked':
        if (!asJson) {
          err('migrate up REFUSED — resolve the drift below before deploying:');
          err(formatProblems(result.problems));
          err('');
          err('Runbook: docs/runbooks/migrations.md §"Recovery".');
        }
        return EXIT_DRIFT;
      case 'lock_timeout':
        if (!asJson) {
          err(
            `another migrator holds the global migration lock (waited ${result.lock_wait_ms}ms). ` +
              'Nothing was applied. Retry after it finishes, or raise MIGRATION_LOCK_TIMEOUT_MS.',
          );
        }
        return EXIT_LOCKED;
      case 'failed':
        if (!asJson) {
          err(
            `migration ${result.failed_id} FAILED (${result.error_class})` +
              `${result.dirty ? ' and left DIRTY state — the schema is partially applied' : ' and was rolled back'}.`,
          );
          err('Subsequent migrations were NOT attempted. See docs/runbooks/migrations.md §"Recovery".');
        }
        return EXIT_FAILED;
    }
  });
}

async function cmdRepair(flags: Flags, asJson: boolean): Promise<number> {
  const id = typeof flags.named.id === 'string' ? flags.named.id : '';
  const resolution = flags.named.resolution;
  const reason = typeof flags.named.reason === 'string' ? flags.named.reason.trim() : '';
  // Deliberately NOT inferred from the shell user: a repair record whose actor
  // is "whoever happened to be logged into the box" is not evidence. The
  // operator names themselves, and that name is what lands in the trail.
  const actor = typeof flags.named.actor === 'string' ? flags.named.actor.trim() : '';

  if (!id) return usageError('repair requires --id <migration filename>');
  if (resolution !== 'applied' && resolution !== 'pending') {
    return usageError('repair requires --resolution applied|pending');
  }
  if (actor.length < 2) {
    return usageError('repair requires --actor "<who is asserting this>"');
  }
  if (reason.length < 10) {
    return usageError(
      'repair requires --reason "<why>" (at least 10 characters). The reason is written ' +
        'to the append-only schema_migration_events trail and is the only record of WHY ' +
        'someone overrode a dirty state.',
    );
  }
  if (flags.named.yes !== true) {
    return usageError(
      'repair is an EXCEPTIONAL operation and needs --yes. Inspect the schema FIRST: ' +
        'clearing the flag without verifying the change is the failure mode this runner exists to prevent.',
    );
  }

  return withMigrationRunner(async (options) => {
    const result = await repairMigration(options, { id, resolution, reason, actor });
    if (asJson) json(result);
    switch (result.outcome) {
      case 'repaired':
        if (!asJson) out(`repaired ${result.id} → ${result.resolution} (actor ${actor}).`);
        return EXIT_OK;
      case 'not_found':
        if (!asJson) err(`no ledger row for ${result.id}; nothing to repair.`);
        return EXIT_DRIFT;
      case 'lock_timeout':
        if (!asJson) err(`another migrator holds the lock (waited ${result.lock_wait_ms}ms).`);
        return EXIT_LOCKED;
    }
  });
}

function usageError(message: string): number {
  err(`maia migrate: ${message}\n\n${USAGE}`);
  return EXIT_ERROR;
}

export async function run(argv: readonly string[]): Promise<number> {
  const flags = parseArgs(argv);
  const [group, command] = flags.positional;
  const asJson = flags.named.json === true;

  if (group === undefined || group === 'help' || flags.named.help === true) {
    out(USAGE);
    return EXIT_OK;
  }
  if (group !== 'migrate') return usageError(`unknown command group "${group}"`);

  switch (command) {
    case 'check':
      return cmdCheck(asJson);
    case 'manifest':
      return cmdManifest(asJson, {
        minSupported: typeof flags.named.min === 'string' ? flags.named.min : null,
        maxSupported: typeof flags.named.max === 'string' ? flags.named.max : null,
      });
    case 'plan':
      return cmdPlan(asJson, false);
    case 'status':
      return cmdPlan(asJson, true);
    case 'up':
      return cmdUp(asJson);
    case 'repair':
      return cmdRepair(flags, asJson);
    default:
      return usageError(`unknown migrate command "${command ?? ''}"`);
  }
}

/** Same cross-platform entrypoint guard used by every script in this repo. */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      // Never let a raw driver error (which can carry the DSN) reach the
      // terminal or a CI log.
      err(`maia migrate: ${describeError(e)}`);
      process.exitCode = EXIT_ERROR;
    });
}
