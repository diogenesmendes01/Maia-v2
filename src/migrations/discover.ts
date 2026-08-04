/**
 * Issue #516 §4 — discovery of the packaged migration artifact.
 *
 * Split in two on purpose:
 *
 *   - `buildMigrationArtifact()` is PURE — it takes `{ filename, contents }`
 *     pairs and produces the artifact. Every ordering, marker, down-sibling and
 *     checksum rule is testable from plain objects, with no filesystem.
 *   - `discoverMigrations()` is the thin disk wrapper used by the CLI and by
 *     the readiness API.
 *
 * Ordering is plain UTF-16 code-unit order over the FULL filename, matching the
 * pre-#516 runner (`Array.prototype.sort()` in `scripts/migrate.ts`) exactly.
 * That matters: a different collation would reorder the historical duplicate
 * prefixes (007, 014, 015, … — issue #308) relative to how they were actually
 * applied in production. `localeCompare` is deliberately NOT used; it is
 * locale-dependent and would make the order machine-specific.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrationChecksum } from './checksum.js';
import type { ArtifactProblem, DiscoveredMigration, MigrationArtifact } from './types.js';

/**
 * Migrations that need to run outside a transaction (e.g. `CREATE INDEX
 * CONCURRENTLY`, which Postgres rejects inside `BEGIN/COMMIT`) opt in by
 * putting `-- maia:no-transaction` on its own line at the top of the file.
 */
export const NO_TX_MARKER = /^[ \t]*--[ \t]*maia:no-transaction\b/m;

/**
 * Per-migration `statement_timeout` override (issue #516 §8: "Override por
 * migration somente via marker versionado e revisável"). A long data backfill
 * declares its own ceiling in the file, where a reviewer sees it — not in the
 * operator's shell, where nobody does.
 */
export const STATEMENT_TIMEOUT_MARKER = /^[ \t]*--[ \t]*maia:statement-timeout=(\d+)\b/m;

/**
 * A file that opens its OWN top-level transaction (`BEGIN;`).
 *
 * This matters more than it looks. The pre-#516 runner wrapped every migration
 * in its own `BEGIN`/`COMMIT` and wrote the ledger row inside that envelope,
 * believing "schema changed" and "schema recorded" were atomic. For a file that
 * already contains `BEGIN; … COMMIT;` they are NOT: Postgres does not nest
 * transactions, so the file's own `COMMIT` ends the runner's transaction, the
 * ledger `INSERT` that follows runs in autocommit, and the runner's trailing
 * `COMMIT` warns "no transaction in progress". A crash in that gap leaves the
 * schema changed and the ledger silent — the migration re-runs on next boot.
 *
 * So the runner classifies instead of pretending (see `runner.ts`): files with
 * no transaction control of their own get the genuinely atomic path, files with
 * their own get the `running`-first protocol that makes the gap VISIBLE.
 *
 * Matched on the comment-stripped text so a `-- BEGIN;` in prose does not count.
 * `DO $$ BEGIN … END $$` is not matched: PL/pgSQL's `BEGIN` is a block opener
 * and carries no `;`.
 */
export const OWN_TRANSACTION_MARKER = /^[ \t]*(BEGIN|START[ \t]+TRANSACTION)[ \t]*;/im;

/** `true` when the migration manages its own top-level transaction. */
export function hasOwnTransactionControl(sql: string): boolean {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return OWN_TRANSACTION_MARKER.test(withoutComments);
}

/** Parse the `-- maia:statement-timeout=<ms>` marker, if present. */
export function statementTimeoutOf(sql: string): number | null {
  const m = sql.match(STATEMENT_TIMEOUT_MARKER);
  if (!m) return null;
  const ms = Number.parseInt(m[1]!, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A conforming migration prefix token: digits + a single optional letter. */
export const PREFIX_SHAPE = /^[0-9]+[a-z]?$/;

/**
 * Split a no-transaction migration into individual statements.
 *
 * Why this is required: node-postgres' simple-query protocol wraps MULTIPLE
 * statements sent in one `client.query()` call in an implicit transaction. So a
 * no-tx file with more than one `CREATE INDEX CONCURRENTLY` (e.g. migration
 * 066) still fails with "CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction block" unless each statement is sent on its own. We strip `--`
 * line comments and split on `;`.
 *
 * Constraint: no-transaction migrations may ONLY contain simple statements
 * terminated by a top-level `;` (CONCURRENTLY index DDL). They must NOT contain
 * dollar-quoted bodies (`DO $$ ... $$`) or string literals containing `;` —
 * anything that complex can and should run inside a transaction (i.e. without
 * the marker), where the whole file is sent as one query. This keeps the
 * splitter dependency-free and safe.
 */
export function splitNoTxStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/** `true` for a forward migration filename (excludes `_down.sql`). */
export function isForwardMigration(filename: string): boolean {
  return filename.endsWith('.sql') && !filename.endsWith('_down.sql');
}

/** The `_down.sql` sibling filename for a forward migration id. */
export function downSiblingOf(id: string): string {
  return `${id.slice(0, -'.sql'.length)}_down.sql`;
}

/** Leading prefix token of a migration filename, or `null` when malformed. */
export function prefixOf(filename: string): string | null {
  const m = filename.match(/^([^_]+)_/);
  if (!m) return null;
  const seg = m[1]!;
  return PREFIX_SHAPE.test(seg) ? seg : null;
}

/**
 * Total order over migration ids. Locale-independent by construction — plain
 * code-unit comparison, identical to `Array.prototype.sort()` with no
 * comparator, which is what the pre-#516 runner used.
 */
export function compareMigrationIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface MigrationSource {
  readonly filename: string;
  readonly contents: string;
}

/**
 * Build the artifact from raw file contents. Pure.
 *
 * `downFilenames` is the set of `_down.sql` files present alongside the forward
 * ones; a forward migration without its sibling is reported as a problem
 * (AGENTS.md §4 rule 6: "New migration file with `_up` + `_down`") rather than
 * silently accepted.
 */
export function buildMigrationArtifact(
  sources: readonly MigrationSource[],
  downFilenames: readonly string[] = [],
): MigrationArtifact {
  const problems: ArtifactProblem[] = [];
  const downs = new Set(downFilenames);
  const byId = new Map<string, DiscoveredMigration>();

  const forward = sources
    .filter((s) => isForwardMigration(s.filename))
    .slice()
    .sort((a, b) => compareMigrationIds(a.filename, b.filename));

  const migrations: DiscoveredMigration[] = [];
  for (const source of forward) {
    const id = source.filename;
    if (byId.has(id)) {
      problems.push({
        kind: 'duplicate_id',
        id,
        detail: `"${id}" appears more than once in the artifact`,
      });
      continue;
    }
    const prefix = prefixOf(id);
    if (prefix === null) {
      problems.push({
        kind: 'malformed_prefix',
        id,
        detail: `"${id}" has no leading ^[0-9]+[a-z]?$ prefix token`,
      });
    }
    const hasDownSibling = downs.has(downSiblingOf(id));
    if (!hasDownSibling) {
      problems.push({
        kind: 'missing_down_sibling',
        id,
        detail: `"${id}" has no "${downSiblingOf(id)}" sibling — every forward migration is reversible by contract`,
      });
    }
    const noTransaction = NO_TX_MARKER.test(source.contents);
    const migration: DiscoveredMigration = {
      id,
      prefix,
      checksum: migrationChecksum(source.contents),
      noTransaction,
      transactionMode: noTransaction
        ? 'none'
        : hasOwnTransactionControl(source.contents)
          ? 'self'
          : 'runner',
      hasDownSibling,
      statementTimeoutMs: statementTimeoutOf(source.contents),
      sql: source.contents,
    };
    byId.set(id, migration);
    migrations.push(migration);
  }

  return {
    migrations,
    byId,
    head: migrations.length > 0 ? migrations[migrations.length - 1]!.id : null,
    problems,
  };
}

/** Read every `.sql` under `dir` and build the artifact. */
export async function discoverMigrations(dir: string): Promise<MigrationArtifact> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  const forward = entries.filter(isForwardMigration).sort(compareMigrationIds);
  const downs = entries.filter((f) => f.endsWith('_down.sql'));
  const sources: MigrationSource[] = [];
  for (const filename of forward) {
    sources.push({ filename, contents: await readFile(join(dir, filename), 'utf8') });
  }
  return buildMigrationArtifact(sources, downs);
}
