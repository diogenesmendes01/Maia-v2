/**
 * Schema compatibility (issue #516 §6) — the contract `/readyz`,
 * `maia migrate status` and `maia doctor` (#517) all read.
 *
 * PURE module: it takes the packaged artifact (what the build shipped) and the
 * ledger (what the database says happened) and answers ONE question — is this
 * database in a state the running code was built for? It never queries, never
 * applies, never mutates. That is what makes it unit-testable without Postgres
 * and safe to call from a public probe.
 *
 * Every `detail` string is OUR literal. Driver messages, DSNs and internal
 * paths never enter this module, so its output is safe to serialise verbatim.
 */
import type {
  DiscoveredMigration,
  Drift,
  LedgerRow,
  SchemaCompatibility,
  SchemaCounters,
} from './types.js';
import { BLOCKS_READINESS } from './types.js';
import { expectedHead } from './discover.js';

/**
 * How long a `running` row may sit before it is treated as a crashed run
 * rather than a live one.
 *
 * Deliberately generous: a legitimately slow `CREATE INDEX CONCURRENTLY` on a
 * large table can run for many minutes, and declaring it stale while it is
 * still working would make a second migrator report a false `running_stale`.
 * The advisory lock is what actually prevents concurrent execution; this
 * budget only decides when the OPERATOR is told to go look.
 */
export const DEFAULT_RUNNING_STALE_MS = 30 * 60_000;

export interface CompatibilityInput {
  /** Forward migrations in the build artifact, in apply order. */
  readonly migrations: readonly DiscoveredMigration[];
  /** Every `schema_migrations` row. */
  readonly rows: readonly LedgerRow[];
  /** Oldest applied head this build tolerates. `null` ⇒ expected head. */
  readonly minSupported?: string | null;
  /** Newest applied head this build tolerates. `null` ⇒ unbounded. */
  readonly maxSupported?: string | null;
  readonly runningStaleMs?: number;
  /** Injected for deterministic tests. */
  readonly now?: number;
}

function counters(
  migrations: readonly DiscoveredMigration[],
  rows: readonly LedgerRow[],
  mismatches: number,
  pending: number,
): SchemaCounters {
  return {
    total_files: migrations.length,
    applied_count: rows.filter((r) => r.status === 'applied').length,
    pending_count: pending,
    dirty_count: rows.filter((r) => r.status === 'dirty').length,
    failed_count: rows.filter((r) => r.status === 'failed').length,
    running_count: rows.filter((r) => r.status === 'running').length,
    mismatch_count: mismatches,
    backfilled_count: rows.filter((r) => r.checksum_source === 'backfilled').length,
  };
}

/**
 * Compare the artifact against the ledger.
 *
 * Ordering note: `applied_head` is the LEXICALLY greatest id with an `applied`
 * row, which is the same order the runner applies files in. A `dirty` or
 * `failed` row is explicitly NOT part of the head — dirty is never read as
 * success (issue #516, "Estado dirty nunca é interpretado como sucesso").
 */
export function evaluateCompatibility(input: CompatibilityInput): SchemaCompatibility {
  const { migrations, rows } = input;
  const now = input.now ?? Date.now();
  const staleMs = input.runningStaleMs ?? DEFAULT_RUNNING_STALE_MS;

  const expected = expectedHead(migrations);
  const minSupported = input.minSupported ?? expected;
  const maxSupported = input.maxSupported ?? null;

  const byId = new Map(migrations.map((m) => [m.id, m]));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const problems: Drift[] = [];
  let mismatches = 0;

  // ---- ledger side: what the database claims ----------------------------
  const appliedIds: string[] = [];
  for (const row of rows) {
    const file = byId.get(row.id);

    if (row.status === 'applied') appliedIds.push(row.id);

    if (!file) {
      // A ledger row with no file in this build. Two very different causes,
      // and conflating them would drain the fleet on every rollback deploy:
      //
      //   - id NEWER than the expected head ⇒ the DATABASE is ahead, i.e. an
      //     older release running after a code rollback. Legitimate under
      //     expand/contract; whether this build tolerates it is decided by
      //     `max_supported`, not here.
      //   - id at or below the expected head ⇒ a merged migration was renamed
      //     or deleted. That is the append-only violation (AGENTS.md §4.6) and
      //     it needs a human.
      if (expected !== null && row.id > expected) continue;
      problems.push({
        code: 'missing_file',
        severity: 'error',
        id: row.id,
        detail: `migration ${row.id} is recorded in the ledger but absent from this build`,
      });
      continue;
    }

    if (row.status === 'applied' && row.checksum_sha256 && row.checksum_sha256 !== file.checksum) {
      mismatches += 1;
      problems.push({
        code: 'checksum_mismatch',
        severity: 'error',
        id: row.id,
        detail:
          `migration ${row.id} was applied with checksum ` +
          `${row.checksum_sha256.slice(0, 12)} but this build ships ` +
          `${file.checksum.slice(0, 12)} — an already-applied migration was edited`,
      });
    }

    if (row.status === 'dirty') {
      problems.push({
        code: 'dirty',
        severity: 'error',
        id: row.id,
        detail:
          `migration ${row.id} is DIRTY: it ran outside a transaction and did not ` +
          'complete, so the schema is partially applied. Inspect it, then use ' +
          '`maia migrate repair`',
      });
    }

    if (row.status === 'failed') {
      problems.push({
        code: 'failed',
        severity: 'error',
        id: row.id,
        detail:
          `migration ${row.id} FAILED (${row.error_class ?? 'unknown class'}); its ` +
          'transaction was rolled back, so no partial change remains — fix the ' +
          'migration and re-run `maia migrate up`',
      });
    }

    if (row.status === 'running') {
      const startedAt = row.started_at ? row.started_at.getTime() : null;
      const ageMs = startedAt === null ? Number.POSITIVE_INFINITY : now - startedAt;
      if (ageMs > staleMs) {
        problems.push({
          code: 'running_stale',
          severity: 'error',
          id: row.id,
          detail:
            `migration ${row.id} has been marked running for longer than the ` +
            'staleness budget — a migrator crashed mid-flight',
        });
      }
    }
  }

  const appliedHead = appliedIds.length > 0 ? appliedIds.sort()[appliedIds.length - 1]! : null;

  // ---- artifact side: what the build expects ----------------------------
  const pending: string[] = [];
  for (const file of migrations) {
    const row = rowById.get(file.id);
    if (row?.status === 'applied') continue;
    // `dirty` / `failed` / `running` rows are reported above; they are also
    // still un-applied, so they belong in the pending list the runner walks.
    pending.push(file.id);

    if (appliedHead !== null && file.id < appliedHead) {
      problems.push({
        code: 'out_of_order',
        severity: 'warn',
        id: file.id,
        detail:
          `migration ${file.id} is pending but sorts before the applied head ` +
          `${appliedHead} — two branches merged out of authoring order`,
      });
    }
  }

  for (const file of migrations) {
    if (file.prefix === null) {
      problems.push({
        code: 'malformed_id',
        severity: 'error',
        id: file.id,
        detail: `migration ${file.id} has no conforming numeric prefix`,
      });
    }
    if (file.downId === null) {
      problems.push({
        code: 'missing_down_sibling',
        severity: 'error',
        id: file.id,
        detail: `migration ${file.id} ships without its _down.sql sibling (AGENTS.md §4.6)`,
      });
    }
  }

  if (pending.length > 0) {
    problems.push({
      code: 'pending',
      severity: 'error',
      id: pending[pending.length - 1]!,
      detail:
        `${pending.length} migration(s) on disk are not applied (head applied ` +
        `${appliedHead ?? 'none'}, head expected ${expected ?? 'none'}) — run \`maia migrate up\``,
    });
  }

  // ---- supported range (expand/contract rollout) ------------------------
  if (minSupported !== null && appliedHead !== null && appliedHead < minSupported) {
    problems.push({
      code: 'below_min',
      severity: 'error',
      id: appliedHead,
      detail: `applied head ${appliedHead} is older than the minimum this build supports (${minSupported})`,
    });
  }
  if (maxSupported !== null && appliedHead !== null && appliedHead > maxSupported) {
    problems.push({
      code: 'above_max',
      severity: 'error',
      id: appliedHead,
      detail:
        `applied head ${appliedHead} is newer than the maximum this build supports ` +
        `(${maxSupported}) — this database was migrated by a newer release`,
    });
  }

  return {
    compatible: !problems.some((p) => BLOCKS_READINESS.has(p.code)),
    expected_head: expected,
    applied_head: appliedHead,
    min_supported: minSupported,
    max_supported: maxSupported,
    pending,
    problems,
    counters: counters(migrations, rows, mismatches, pending.length),
  };
}

/** The first blocking problem, for a one-line `reason`. */
export function firstBlocker(
  compat: SchemaCompatibility,
  blocks: ReadonlySet<Drift['code']> = BLOCKS_READINESS,
): Drift | null {
  return compat.problems.find((p) => blocks.has(p.code)) ?? null;
}
