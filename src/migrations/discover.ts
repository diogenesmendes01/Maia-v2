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
import type {
  ArtifactProblem,
  DiscoveredMigration,
  MigrationArtifact,
  TransactionEnvelope,
} from './types.js';

export type { TransactionEnvelope };

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
 * Kept exported for reference and for the regression test that pins the
 * historical classification of the 244 packaged files, but the classifier below
 * no longer uses it: a line-anchored regex cannot tell `BEGIN;` in the file's
 * body from `BEGIN;` inside a dollar-quoted function body, and cannot see
 * `BEGIN WORK;` / `START TRANSACTION ISOLATION LEVEL …` at all.
 */
export const OWN_TRANSACTION_MARKER = /^[ \t]*(BEGIN|START[ \t]+TRANSACTION)[ \t]*;/im;

/** A top-level statement that OPENS a transaction. */
const OPENS_TRANSACTION = /^(BEGIN|START[\s]+TRANSACTION)\b/i;

/**
 * A top-level statement that CLOSES one. `END` is Postgres' documented synonym
 * for `COMMIT`; PL/pgSQL's block-closing `END` never reaches this test because
 * it lives inside a dollar-quoted body, which the tokeniser consumes whole.
 */
const CLOSES_TRANSACTION = /^(COMMIT|END|ROLLBACK|ABORT)\b/i;

/** A close that COMMITS (as opposed to discarding) the work. */
const COMMITS_TRANSACTION = /^(COMMIT|END)\b/i;

/**
 * Opening (or closing) delimiter of a dollar-quoted string. A tag follows the
 * rules of an unquoted identifier minus the dollar sign, so `$1` and `$2` bind
 * placeholders deliberately do NOT match.
 */
const DOLLAR_QUOTE_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/;

/**
 * Split SQL into top-level statements.
 *
 * A naive `split(';')` is wrong for exactly the files this matters for, so this
 * honours the lexical rules that hide a `;` from statement level:
 *
 *   - `--` line comments and `/* … *\/` block comments (nestable in Postgres);
 *   - single-quoted literals, with `''` as the escape;
 *   - double-quoted identifiers, with `""` as the escape;
 *   - dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`) — which is what makes
 *     `CREATE FUNCTION … AS $$ … END; $$;` a SINGLE statement instead of four.
 *
 * `$1`-style bind placeholders are not dollar quotes (a tag must start with a
 * letter or underscore) and are left alone. Comments are replaced by a space so
 * two tokens either side of one do not get glued together.
 *
 * A trailing fragment with no terminating `;` is returned as a statement too —
 * dropping it is precisely how "there is code after the COMMIT" goes unnoticed.
 */
export function splitTopLevelStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let buf = '';
  let i = 0;

  const push = (): void => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) out.push(trimmed);
    buf = '';
  };

  while (i < n) {
    const ch = sql[i]!;

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      buf += ' ';
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      buf += ' ';
      continue;
    }

    if (ch === "'" || ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      buf += sql.slice(start, i);
      continue;
    }

    if (ch === '$') {
      const tag = DOLLAR_QUOTE_TAG.exec(sql.slice(i));
      if (tag) {
        const token = tag[0];
        const end = sql.indexOf(token, i + token.length);
        const stop = end === -1 ? n : end + token.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ';') {
      push();
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  push();
  return out;
}

/**
 * Why a `self` migration could not be proven atomic. Each value names the exact
 * shape that breaks the "the file rolled itself back" assumption the runner used
 * to make unconditionally.
 */
export type EnvelopeDefect =
  /** Executable SQL before the opening `BEGIN;` — it runs in autocommit. */
  | 'statement_before_begin'
  /** Executable SQL after the closing `COMMIT;` — the DDL is already durable. */
  | 'statement_after_commit'
  /** More than one `BEGIN … COMMIT` pair: an early one is already durable. */
  | 'multiple_envelopes'
  /** `BEGIN;` with no matching commit: the runner's connection is left open. */
  | 'unterminated_envelope'
  /** A stray `COMMIT;`/`ROLLBACK;` with no `BEGIN;` of its own. */
  | 'unbalanced_control'
  /** The file closes with `ROLLBACK;`/`ABORT;` — it discards its own work. */
  | 'self_rollback';

export interface EnvelopeAnalysis {
  readonly envelope: TransactionEnvelope;
  readonly defect: EnvelopeDefect | null;
  /** Operator-facing explanation. Never quotes the SQL itself. */
  readonly detail: string | null;
}

const ENVELOPE_ABSENT: EnvelopeAnalysis = { envelope: 'absent', defect: null, detail: null };
const ENVELOPE_OK: EnvelopeAnalysis = { envelope: 'single_complete', defect: null, detail: null };

function unverifiable(defect: EnvelopeDefect, detail: string): EnvelopeAnalysis {
  return { envelope: 'unverifiable', defect, detail };
}

/**
 * Decide whether a file's own transaction control forms ONE complete envelope
 * around ALL of its executable SQL.
 *
 * This is the property the runner's failure classification depends on. `BEGIN;
 * … COMMIT;` around the whole file means any error aborts the transaction and
 * the trailing `COMMIT` degrades to a rollback, so a failure is genuinely
 * retryable (`failed`). Anything else — a statement after the `COMMIT`, two
 * envelopes, an envelope that is never closed — means part of the file can be
 * durably committed while a later statement fails, which is a PARTIALLY APPLIED
 * schema wearing a retryable label.
 */
export function analyzeTransactionEnvelope(sql: string): EnvelopeAnalysis {
  const statements = splitTopLevelStatements(sql);
  const opens: number[] = [];
  const closes: number[] = [];
  statements.forEach((stmt, index) => {
    if (OPENS_TRANSACTION.test(stmt)) opens.push(index);
    else if (CLOSES_TRANSACTION.test(stmt)) closes.push(index);
  });

  if (opens.length === 0 && closes.length === 0) return ENVELOPE_ABSENT;

  if (opens.length === 0) {
    return unverifiable(
      'unbalanced_control',
      'closes a transaction it never opened, so the statements before it were committed by whoever opened one',
    );
  }
  if (closes.length === 0) {
    return unverifiable(
      'unterminated_envelope',
      'opens a transaction and never closes it, so the runner would hand a connection with an open transaction back to the pool and silently lose both the DDL and the ledger row',
    );
  }
  if (opens.length > 1 || closes.length > 1) {
    return unverifiable(
      'multiple_envelopes',
      `contains ${opens.length} transaction opener(s) and ${closes.length} closer(s); every envelope but the last is already durable when a later one fails`,
    );
  }
  if (opens[0] !== 0) {
    return unverifiable(
      'statement_before_begin',
      `has ${opens[0]} executable statement(s) before its BEGIN, which run in autocommit and survive a rollback of the rest`,
    );
  }
  if (closes[0] !== statements.length - 1) {
    return unverifiable(
      'statement_after_commit',
      `has ${statements.length - 1 - closes[0]!} executable statement(s) after its COMMIT; everything inside the envelope is already durable when one of them fails`,
    );
  }
  if (!COMMITS_TRANSACTION.test(statements[closes[0]!]!)) {
    return unverifiable(
      'self_rollback',
      'ends by discarding its own transaction (ROLLBACK/ABORT), so it can never be recorded as applied',
    );
  }
  return ENVELOPE_OK;
}

/**
 * `true` when the migration manages its own top-level transaction.
 *
 * Derived from the tokenised statement list rather than a line-anchored regex,
 * so `BEGIN WORK;`, `START TRANSACTION ISOLATION LEVEL SERIALIZABLE;` and a
 * stray top-level `COMMIT;` are all seen, while `BEGIN` inside a dollar-quoted
 * PL/pgSQL body or inside a comment is not. The classification of the 244
 * packaged files is unchanged — pinned by `discover.spec.ts`.
 */
export function hasOwnTransactionControl(sql: string): boolean {
  return analyzeTransactionEnvelope(sql).envelope !== 'absent';
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
    const analysis = analyzeTransactionEnvelope(source.contents);
    const transactionMode = noTransaction
      ? 'none'
      : analysis.envelope === 'absent'
        ? 'runner'
        : 'self';
    // The guardrail the #541 review asked for. `self` mode records a clean
    // failure as `failed` (auto-retried) on the strength of ONE property: the
    // file rolls its own work back. That property holds only for a single
    // complete envelope. `BEGIN; … COMMIT; <more SQL>` has the same `BEGIN;`
    // and none of the guarantee — the DDL is durable and the runner's ROLLBACK
    // is a no-op — so the file is refused here, before any DDL runs, rather
    // than trusted and mislabelled afterwards.
    if (transactionMode === 'self' && analysis.envelope === 'unverifiable') {
      problems.push({
        kind: 'unverifiable_transaction_envelope',
        id,
        detail: `"${id}" manages its own transaction but ${analysis.detail} [${analysis.defect}]. Wrap the whole file in ONE "BEGIN; … COMMIT;", or drop the transaction control and let the runner own it (then the ledger row commits atomically with the schema change).`,
      });
    }
    const migration: DiscoveredMigration = {
      id,
      prefix,
      checksum: migrationChecksum(source.contents),
      noTransaction,
      transactionMode,
      transactionEnvelope: analysis.envelope,
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
