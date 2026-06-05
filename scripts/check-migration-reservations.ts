/**
 * Issue #340 — merge-time migration-prefix reservation guard.
 *
 * Background
 * ----------
 * `tests/unit/scripts/migration-number-uniqueness.spec.ts` (added in #329)
 * catches duplicate migration prefixes, but it runs only against the CURRENT
 * checkout at CI/test-time. It cannot stop two CONCURRENT PRs from each
 * picking the same prefix: both pass CI on their own branch, and the
 * collision only surfaces AFTER the second PR merges.
 *
 * The fix is `migrations/RESERVATIONS.md`: a single, APPEND-ONLY ledger.
 * Every new migration appends one line at the END of the file. Two PRs that
 * reserve the SAME prefix both append a new last line to the same region, so
 * the second PR to merge hits an UNRESOLVABLE git merge conflict on
 * `RESERVATIONS.md` — converting a silent post-merge collision into an
 * explicit, early, merge-time conflict. See the ledger header for the full
 * rationale.
 *
 * This script is the disk-aware guard that backs the ledger. It verifies:
 *   (a) every forward `.sql` migration on disk has EXACTLY ONE matching
 *       reservation entry (keyed by full filename),
 *   (b) every reservation entry points at a real forward `.sql` file (no
 *       stale / typo'd entries),
 *   (c) entries are well-formed (`<prefix> | <filename> | <purpose>`, with a
 *       conforming `^[0-9]+[a-z]?$` prefix that matches the filename's leading
 *       token), and no duplicate reservation lines,
 *   (d) no NEW duplicate prefix on disk: the set of prefixes shared by more
 *       than one migration file must be exactly the grandfathered allowlist
 *       (the pre-#340 shared prefixes — see migration-number-uniqueness.spec).
 *
 * It deliberately reuses NOTHING from the heavier governance check
 * (`check-ai-docs.ts`); it is a small, dependency-free, plain-Node guard in
 * the same house style. The pure helpers below are exported so the spec can
 * exercise them against synthetic inputs without touching disk.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A conforming migration prefix token: digits + a single optional letter. */
export const PREFIX_SHAPE = /^[0-9]+[a-z]?$/;

/** The ledger filename, relative to the migrations directory. */
export const LEDGER_FILENAME = 'RESERVATIONS.md';

/**
 * Everything ABOVE this marker in the ledger is human documentation (the
 * header, format example, fenced code) and is ignored by the parser; reserved
 * entries live strictly BELOW it. Gating on the marker means prose that
 * legitimately contains a `|` (e.g. the `<prefix> | <filename> | <purpose>`
 * format example) is never mistaken for a data row. The marker is also the
 * "append new entries below this line" contract documented in the header.
 */
export const RESERVATIONS_MARKER = '<!-- BEGIN RESERVATIONS';

/**
 * Prefixes legitimately shared by more than one forward migration BEFORE this
 * ledger existed (already merged + applied; benign because the runner keys on
 * the full filename — see docs/runbooks/migrations.md and issue #308). This is
 * the SAME accepted set frozen by
 * tests/unit/scripts/migration-number-uniqueness.spec.ts. New code must NOT add
 * shared prefixes; pick `max(existing) + 1`.
 */
export const GRANDFATHERED_SHARED_PREFIXES: readonly string[] = [
  '007',
  '014',
  '015',
  '018',
  '020',
  '023',
  '025',
  '026',
  '027',
  '031',
  '062',
  '063',
];

export interface Reservation {
  /** 1-based line number within the ledger file (for error messages). */
  readonly line: number;
  readonly prefix: string;
  readonly filename: string;
  readonly purpose: string;
}

/**
 * The conforming leading prefix of a forward `.sql` filename, or `null` if the
 * leading token (everything before the first `_`) is missing or does not match
 * `^[0-9]+[a-z]?$`. Mirrors the parser in migration-number-uniqueness.spec so
 * the two guards agree on what a "prefix" is.
 */
export function prefixOf(filename: string): string | null {
  const m = filename.match(/^([^_]+)_/);
  if (!m) return null;
  const seg = m[1]!;
  return PREFIX_SHAPE.test(seg) ? seg : null;
}

/** Forward migration filenames (excludes `_down.sql` and the ledger itself). */
export function forwardMigrations(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

/**
 * Parse the ledger into reservation entries. Only the region BELOW the
 * `RESERVATIONS_MARKER` is scanned for data rows — the header above it is
 * documentation and may legitimately contain a `|` (e.g. the format example),
 * which marker-gating keeps out of the data set. Below the marker, blanks and
 * stray `#`/`<!--` lines are skipped; a data line is recognised by containing
 * the `|` field separator. The parser is strict about the THREE-field shape
 * and reports a descriptive error (with line number) for anything malformed.
 *
 * Pure + disk-free so the spec can feed it synthetic ledgers.
 */
export function parseLedger(content: string): {
  reservations: Reservation[];
  errors: string[];
} {
  const reservations: Reservation[] = [];
  const errors: string[] = [];

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  // Only the region BELOW the marker holds data rows; the header above it is
  // documentation (and may legitimately contain `|` in prose / fenced code).
  let inEntries = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (!inEntries) {
      if (trimmed.startsWith(RESERVATIONS_MARKER)) inEntries = true;
      continue;
    }

    // Below the marker: skip blanks, stray comments, and any future markdown.
    // A reservation line always has `|`; everything else is ignored so the
    // ledger can still carry a trailing prose note if needed.
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('<!--')) {
      continue;
    }
    if (!trimmed.includes('|')) {
      continue;
    }

    const lineNo = i + 1;
    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length !== 3) {
      errors.push(
        `${LEDGER_FILENAME}:${lineNo}: malformed entry (expected ` +
          `"<prefix> | <filename> | <purpose>", got ${parts.length} field(s)): ${trimmed}`,
      );
      continue;
    }

    const [prefix, filename, purpose] = parts as [string, string, string];

    if (!PREFIX_SHAPE.test(prefix)) {
      errors.push(
        `${LEDGER_FILENAME}:${lineNo}: prefix "${prefix}" is not of the form ` +
          `^[0-9]+[a-z]?$ (digits + a single optional lowercase letter)`,
      );
      continue;
    }
    if (!filename.endsWith('.sql') || filename.endsWith('_down.sql')) {
      errors.push(
        `${LEDGER_FILENAME}:${lineNo}: filename "${filename}" must be a forward ` +
          `migration (ends in .sql, not _down.sql)`,
      );
      continue;
    }
    if (prefixOf(filename) !== prefix) {
      errors.push(
        `${LEDGER_FILENAME}:${lineNo}: prefix "${prefix}" does not match the ` +
          `leading token of filename "${filename}" (${prefixOf(filename) ?? 'none'})`,
      );
      continue;
    }
    if (purpose === '') {
      errors.push(`${LEDGER_FILENAME}:${lineNo}: purpose must not be empty`);
      continue;
    }

    reservations.push({ line: lineNo, prefix, filename, purpose });
  }

  return { reservations, errors };
}

/**
 * Cross-check parsed reservations against the forward migrations on disk and
 * the grandfathered shared-prefix allowlist. Returns a flat list of problem
 * messages (empty = healthy). Pure: callers supply both sides, so the spec can
 * drive it with synthetic file lists + ledger text.
 */
export function findReservationProblems(
  reservations: Reservation[],
  forwardFiles: string[],
  grandfatheredSharedPrefixes: readonly string[] = GRANDFATHERED_SHARED_PREFIXES,
): string[] {
  const problems: string[] = [];

  // Duplicate reservation lines (same filename reserved twice).
  const seen = new Map<string, number>();
  for (const r of reservations) {
    const prev = seen.get(r.filename);
    if (prev !== undefined) {
      problems.push(
        `${LEDGER_FILENAME}: filename "${r.filename}" is reserved more than ` +
          `once (lines ${prev} and ${r.line}); each migration gets exactly one entry`,
      );
    } else {
      seen.set(r.filename, r.line);
    }
  }

  const reservedFiles = new Set(reservations.map((r) => r.filename));
  const onDisk = new Set(forwardFiles);

  // (a) every migration on disk has a reservation.
  for (const file of forwardFiles) {
    if (!reservedFiles.has(file)) {
      problems.push(
        `migration "${file}" has no entry in ${LEDGER_FILENAME}. Reserve it ` +
          `(npm run migrate:reserve "<purpose>") or append a line by hand.`,
      );
    }
  }

  // (b) every reservation points at a real migration file.
  for (const r of reservations) {
    if (!onDisk.has(r.filename)) {
      problems.push(
        `${LEDGER_FILENAME}:${r.line}: reserves "${r.filename}", which does not ` +
          `exist as a forward migration on disk (stale or typo'd entry).`,
      );
    }
  }

  // (d) no NEW duplicate prefix on disk beyond the grandfathered allowlist.
  const allowed = new Set(grandfatheredSharedPrefixes);
  const byPrefix = new Map<string, string[]>();
  for (const file of forwardFiles) {
    const p = prefixOf(file);
    if (p === null) continue; // malformed names are the other guard's job
    const list = byPrefix.get(p) ?? [];
    list.push(file);
    byPrefix.set(p, list);
  }
  for (const [prefix, files] of byPrefix) {
    if (files.length > 1 && !allowed.has(prefix)) {
      problems.push(
        `prefix "${prefix}" is shared by ${files.length} migrations ` +
          `(${files.sort().join(', ')}) but is not grandfathered. Two concurrent ` +
          `PRs likely reserved the same prefix — pick max(existing)+1 and rename ` +
          `your new file (and its _down sibling).`,
      );
    }
  }

  return problems;
}

/** Read the ledger from disk; returns its raw text. */
export function readLedger(migrationsDir: string): string {
  return readFileSync(join(migrationsDir, LEDGER_FILENAME), 'utf8');
}

function fail(message: string): never {
  console.error(`check-migration-reservations failed:\n${message}`);
  process.exit(1);
}

export function runGuard(migrationsDir: string): void {
  const { reservations, errors } = parseLedger(readLedger(migrationsDir));
  const forwardFiles = forwardMigrations(migrationsDir);
  const problems = [...errors, ...findReservationProblems(reservations, forwardFiles)];

  if (problems.length > 0) {
    fail(problems.map((p) => `  - ${p}`).join('\n'));
  }

  console.log(
    `check-migration-reservations passed: ${reservations.length} reservation(s) ` +
      `cover ${forwardFiles.length} forward migration(s).`,
  );
}

function main(): void {
  runGuard(join(process.cwd(), 'migrations'));
}

/**
 * Only run `main()` when this file is the process entrypoint — NOT when the
 * spec imports the pure helpers. Same cross-platform technique as
 * scripts/migrate.ts#isDirectInvocation (and embeddings-rebuild.ts): compare
 * `import.meta.url` (a `file://` URL) to argv[1] normalised via
 * `pathToFileURL` so the check holds on Windows (`file:///C:/...`) and POSIX
 * alike. Kept inline so the guard stays dependency-free and does NOT import
 * scripts/migrate.ts, which would pull in pg + config/env validation (the
 * lightweight CI guard job has no DATABASE_URL).
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
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
