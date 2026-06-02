/**
 * Issue #340 — `npm run migrate:reserve "<purpose>"` helper.
 *
 * Prints the next free migration prefix (`max(existing numeric prefix) + 1`,
 * zero-padded to 3 digits) and, when given a purpose, APPENDS a reservation
 * line to `migrations/RESERVATIONS.md` so you reserve the prefix BEFORE
 * writing the (expensive) `.sql`. The append-only single-file shape is what
 * turns a concurrent same-prefix reservation into a merge-time git conflict
 * — see the ledger header and scripts/check-migration-reservations.ts.
 *
 * Usage:
 *   npm run migrate:reserve                 # just print the next free prefix
 *   npm run migrate:reserve "outbox dedupe" # reserve NNN_<slug>.sql for it
 *   npm run migrate:reserve "x" --filename 074_my_name.sql  # explicit filename
 *
 * It does NOT create the .sql files (that stays a deliberate human step). It
 * only writes one line; the guard then enforces the rest. Dependency-free,
 * plain Node.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEDGER_FILENAME, prefixOf } from './check-migration-reservations.js';

/** Highest numeric prefix in use across forward migrations (ignores letters). */
export function maxNumericPrefix(forwardFiles: string[]): number {
  let max = 0;
  for (const f of forwardFiles) {
    const m = f.match(/^(\d+)/);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max;
}

/** The next free prefix, zero-padded to at least 3 digits (e.g. `074`). */
export function nextFreePrefix(forwardFiles: string[]): string {
  return String(maxNumericPrefix(forwardFiles) + 1).padStart(3, '0');
}

/** Turn a free-text purpose into a filename slug: lowercase snake_case. */
export function slugify(purpose: string): string {
  return purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function forwardMigrations(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

/** Parse `--filename <name>` out of argv, returning [filename?, rest[]]. */
export function parseArgs(argv: string[]): { filename?: string; purpose?: string } {
  const out: { filename?: string; purpose?: string } = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--filename') {
      out.filename = argv[i + 1];
      i += 1;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 0) out.purpose = positionals.join(' ');
  return out;
}

function main(): void {
  const migrationsDir = join(process.cwd(), 'migrations');
  const forwardFiles = forwardMigrations(migrationsDir);
  const next = nextFreePrefix(forwardFiles);
  const { filename, purpose } = parseArgs(process.argv.slice(2));

  if (!purpose) {
    console.log(`Next free migration prefix: ${next}`);
    console.log(
      `To reserve it: npm run migrate:reserve "<short purpose>"\n` +
        `Then create migrations/${next}_<short_name>.sql (+ _down.sql).`,
    );
    return;
  }

  const file = filename ?? `${next}_${slugify(purpose)}.sql`;
  const prefix = prefixOf(file);
  if (prefix === null) {
    console.error(
      `Refusing to reserve: filename "${file}" has no conforming prefix ` +
        `(^[0-9]+[a-z]?$ before the first underscore). Pass --filename ` +
        `${next}_<short_name>.sql explicitly.`,
    );
    process.exit(1);
  }

  // Guard against double-reserving the same line if re-run.
  const ledgerPath = join(migrationsDir, LEDGER_FILENAME);
  const existing = readFileSync(ledgerPath, 'utf8');
  if (existing.split('\n').some((l) => l.trim().split('|')[1]?.trim() === file)) {
    console.error(`Refusing to reserve: "${file}" is already in ${LEDGER_FILENAME}.`);
    process.exit(1);
  }

  const entry = `${prefix} | ${file} | ${purpose}\n`;
  // Append-only: a trailing newline already terminates the last entry, so a
  // bare append lands the new line at the very bottom — the region two
  // concurrent reservations collide on (merge-time conflict by design).
  appendFileSync(ledgerPath, existing.endsWith('\n') ? entry : `\n${entry}`);

  console.log(`Reserved prefix ${prefix} in ${LEDGER_FILENAME}:`);
  console.log(`  ${entry.trimEnd()}`);
  console.log(`Now create migrations/${file} and migrations/${file.replace(/\.sql$/, '_down.sql')}.`);
}

// Entrypoint guard — see scripts/check-migration-reservations.ts for the
// rationale. Kept inline to stay dependency-free (no env/pg import).
function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main();
}
