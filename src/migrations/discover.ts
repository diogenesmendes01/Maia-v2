/**
 * Discovery, markers and checksums (issue #516 §4).
 *
 * This is the "packaged artifact" side of the contract: what the BUILD says
 * the schema should be. The ledger is the other side. Everything downstream
 * (plan, status, up, readiness, doctor) compares those two.
 *
 * Imports only `node:*` — no pg, no config, no logger. That keeps discovery
 * usable from a CI job that has no `DATABASE_URL`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredMigration } from './types.js';

/**
 * Migrations that must run outside a transaction (e.g. `CREATE INDEX
 * CONCURRENTLY`, which Postgres rejects inside `BEGIN/COMMIT`) opt in by
 * putting `-- maia:no-transaction` on its own line at the top of the file.
 *
 * Spelling is unchanged from the pre-#516 runner: the marker is part of the
 * on-disk contract of 118 already-merged files and must never move.
 */
export const NO_TX_MARKER = /^[ \t]*--[ \t]*maia:no-transaction\b/m;

/**
 * `-- maia:idempotent` — the author asserts the file can be re-executed after
 * a partial application without corrupting state (every statement is
 * `IF NOT EXISTS` / `IF EXISTS`-guarded and writes no rows).
 *
 * This is the ONLY thing that lets the runner retry a `no-transaction`
 * migration that crashed mid-flight. Without it a crash leaves `dirty` and an
 * operator has to look at the schema — which is the honest default, because a
 * half-applied non-idempotent DDL chain cannot be distinguished from a
 * complete one by re-running it.
 */
export const IDEMPOTENT_MARKER = /^[ \t]*--[ \t]*maia:idempotent\b/m;

/**
 * `-- maia:statement-timeout=<n>(ms|s|min)` — per-migration override of the
 * runner's default `statement_timeout`. Versioned in the file (so it is
 * reviewed with the DDL it protects) rather than passed on a command line
 * (where it would be invisible in the diff and forgotten under pressure).
 */
export const STATEMENT_TIMEOUT_MARKER = /^[ \t]*--[ \t]*maia:statement-timeout=(\d+)(ms|s|min)\b/m;

/** A conforming migration prefix token: digits + a single optional letter. */
export const PREFIX_SHAPE = /^[0-9]+[a-z]?$/;

/** U+FEFF BYTE ORDER MARK, spelled as an escape so the source stays ASCII. */
const BOM = '\uFEFF';

/**
 * Canonical bytes for hashing.
 *
 * WHY THIS EXISTS: this repo ships no `.gitattributes` and Windows checkouts
 * run with `core.autocrlf=true`, so the very same commit lands on disk as CRLF
 * on a developer laptop and LF in the Linux container. Hashing raw bytes would
 * make every checksum platform-dependent, and the first `checksum_mismatch`
 * would be a false positive that blocks a deploy — which is exactly the alarm
 * this feature must never cry wolf on.
 *
 * The canonical form is therefore: no BOM, LF line endings, no trailing
 * whitespace tail, exactly one terminating newline. Two files that differ only
 * in those respects are the SAME migration, and their checksums have to agree.
 *
 * This is a normalisation, not a parse: a single changed character anywhere in
 * the SQL still changes the hash.
 */
export function canonicalizeSql(text: string): string {
  const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  // JS `\s` already covers U+FEFF and NBSP, so the trailing trim needs no
  // special case — only the leading BOM does.
  return `${withoutBom.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
}

/** sha256 (lowercase hex) of the canonicalised text. */
export function checksumOf(text: string): string {
  return createHash('sha256').update(canonicalizeSql(text), 'utf8').digest('hex');
}

/** First 12 hex chars — what goes into logs and CLI output. */
export function shortChecksum(checksum: string): string {
  return checksum.slice(0, 12);
}

/** Leading prefix token of a forward filename, or `null` when malformed. */
export function prefixOf(filename: string): string | null {
  const m = filename.match(/^([^_]+)_/);
  if (!m) return null;
  return PREFIX_SHAPE.test(m[1]!) ? m[1]! : null;
}

/**
 * Split a no-transaction migration into individual statements.
 *
 * Required because node-postgres' simple-query protocol wraps MULTIPLE
 * statements sent in one `client.query()` call in an implicit transaction. So
 * a no-tx file with more than one `CREATE INDEX CONCURRENTLY` (e.g. migration
 * 066) still fails with "CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction block" unless each statement is sent on its own. We strip `--`
 * line comments and split on `;`.
 *
 * Constraint: no-transaction migrations may ONLY contain simple statements
 * terminated by a top-level `;` (CONCURRENTLY index DDL). They must NOT
 * contain dollar-quoted bodies (`DO $$ ... $$`) or string literals containing
 * `;` — anything that complex can and should run inside a transaction (i.e.
 * without the marker), where the whole file is sent as one query. This keeps
 * the splitter dependency-free and safe.
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

/** Parse the `-- maia:statement-timeout=` marker into milliseconds. */
export function parseStatementTimeout(sql: string): number | null {
  const m = sql.match(STATEMENT_TIMEOUT_MARKER);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  return unit === 'min' ? n * 60_000 : unit === 's' ? n * 1000 : n;
}

/** Every marker + the checksum, derived from one file's text. Pure. */
export function describeMigration(
  id: string,
  path: string,
  sql: string,
  downId: string | null,
): DiscoveredMigration {
  return {
    id,
    prefix: prefixOf(id),
    path,
    noTransaction: NO_TX_MARKER.test(sql),
    idempotent: IDEMPOTENT_MARKER.test(sql),
    statementTimeoutMs: parseStatementTimeout(sql),
    checksum: checksumOf(sql),
    downId,
  };
}

/** Default location of the migration artifact inside the build. */
export function defaultMigrationsDir(cwd: string = process.cwd()): string {
  return join(cwd, 'migrations');
}

/**
 * Read every forward migration in `dir`, in APPLY ORDER.
 *
 * Apply order is a plain lexical sort over the filename — identical to the
 * pre-#516 runner and to `schema_migrations`' natural ordering, so a build
 * that adopts this library applies exactly what the old one would have. Do not
 * "improve" it into a numeric sort: the ledger key is the filename, and the
 * two orders disagree on the grandfathered shared prefixes (issue #308).
 *
 * `_down.sql` files are rollback scripts run manually (docs/runbooks/
 * migrations.md); they are never in the forward chain, but their PRESENCE is
 * recorded so `plan`/`status` can report a missing sibling.
 */
export function discoverMigrations(dir: string): DiscoveredMigration[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const downFiles = new Set(entries.filter((f) => f.endsWith('_down.sql')));
  const forward = entries.filter((f) => !f.endsWith('_down.sql')).sort();

  return forward.map((id) => {
    const path = join(dir, id);
    const downId = `${id.slice(0, -'.sql'.length)}_down.sql`;
    return describeMigration(
      id,
      path,
      readFileSync(path, 'utf8'),
      downFiles.has(downId) ? downId : null,
    );
  });
}

/**
 * Newest forward migration in the artifact — the head this build expects.
 * `null` when the directory is unreadable (a container that shipped `dist/`
 * without `migrations/`), which callers must report as `unknown` rather than
 * inventing an answer.
 */
export function expectedHead(migrations: readonly DiscoveredMigration[]): string | null {
  return migrations.length > 0 ? migrations[migrations.length - 1]!.id : null;
}
