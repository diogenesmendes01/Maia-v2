/**
 * Reflection-memory cleanup — admin tool that removes rows from
 * `agent_memories` that were silently written into the legacy
 * `(tenant_id='default', agent_id='default')` bucket by the pre-#251
 * reflection batch worker.
 *
 * BACKGROUND (issue #260):
 *
 *   PR #251 (issue #240) fixed `src/workers/reflection-batch.ts` so future
 *   reflection memories are written under the correct tenant/agent context.
 *   But pre-existing rows produced during the bug window are still sitting
 *   in `agent_memories` under `(tenant_id='default', agent_id='default')` —
 *   a cross-tenant memory leak frozen in storage:
 *
 *     - Vector recall scoped to a real tenant won't return these rows
 *       (post-#237 the WHERE pins tenant_id+agent_id, so they're invisible
 *       to production callers).
 *     - But anything that DOES query the `default` bucket (a legitimate
 *       `default` tenant, an admin tool, a debug session) sees a mix of
 *       every tenant's pre-fix reflections — historical PII leak.
 *     - The rows also continue to occupy storage and participate in the
 *       pgvector index.
 *
 *   The owner decision recorded on issue #260 is **Option A**: hard DELETE
 *   the polluted rows. Backfill (Option B) by correlating with `audit_log`
 *   was rejected as too fragile; documenting and ignoring (Option C) leaves
 *   the storage + index cost AND the historical leak unaddressed.
 *
 * SAFETY GUARANTEES (PR #276 iter 2 — Codex BLOCK resolution):
 *
 *   The Codex review on iter 1 (commit df82d80b) flagged six destructive-
 *   without-guarantees concerns. Iter 2 addresses all six:
 *
 *     1. BACKUP/UNDO — every executed DELETE first snapshots the in-scope
 *        rows into `agent_memories_cleanup_backup` (migration 063) inside
 *        the SAME transaction. The script also supports `--undo=<run_id>`
 *        to restore the snapshotted rows byte-identically.
 *     2. AUDIT-FIRST + PER-BATCH — `admin_audit_log` gets a `started`
 *        row BEFORE the first delete (with cleanup_run_id), then one
 *        `batch_completed` row per batch (with the deleted IDs), then a
 *        `completed` or `failed` row at the end. A crash mid-batch leaves
 *        the `started`/per-batch trail in place — every deleted row IS
 *        accounted for.
 *     3. agent_id IN AUDIT — `agent_id` is now in `change_summary`
 *        alongside `tenant_id`, identifying the cleaned bucket
 *        unambiguously.
 *     4. --yes — added to `parseArgs` to skip the interactive `[y/N]`
 *        prompt so the script can run in CI/cron/Docker non-TTY.
 *        `--yes` does NOT bypass `--accept-heuristic` (that's a separate
 *        knowledge acknowledgement; this just bypasses the keyboard
 *        confirmation).
 *     5. MAX_SAFE_CUTOFF — the script REFUSES any cutoff later than the
 *        PR #251 merge timestamp (2026-05-28T12:55:08Z). Anything later
 *        would risk deleting legitimate post-fix rows that landed in the
 *        race window between tools-default and the fix merge.
 *     6. FROZEN ID LIST — once we snapshot the rows into the backup
 *        table, the DELETE matches on `id IN (snapshot.original_id)`
 *        instead of re-evaluating the predicate per batch. Concurrent
 *        INSERTs cannot expand the deleted set.
 *
 * CONTRACT (mirrors `scripts/embeddings-rebuild.ts` from #244):
 *
 *   1. REQUIRES `--cutoff=<ISO_DATETIME>` — the timestamp BEFORE which rows
 *      are considered polluted (typically the merge commit of PR #251,
 *      `4102556a` = `2026-05-28T12:55:08Z`). The script REFUSES to start
 *      without it. A future cutoff is rejected too (exit 2) — it would
 *      either delete brand-new legitimate rows or be a typo. Cutoffs
 *      LATER than the PR #251 merge are also rejected (see #5 above).
 *
 *   2. DEFAULT BEHAVIOR is `--dry-run`. With no `--execute` flag the script
 *      counts the matching rows, prints the date range and a 5-row sample,
 *      and exits WITHOUT touching any data. This is the safe default
 *      because dropping a row from `agent_memories` is irreversible without
 *      the backup table (the embedding was computed from `conteudo` text
 *      we may not retain elsewhere). With the backup table in place an
 *      operator CAN restore via `--undo`, but the dry-run is still the
 *      cheapest way to verify the predicate before committing.
 *
 *   3. `--execute` is the explicit destructive flag. It REQUIRES the
 *      operator to also pass `--accept-heuristic` (see #5 below for why),
 *      then prompts for `[y/N]` confirmation (unless `--yes` is passed),
 *      then SNAPSHOTS the in-scope rows into the backup table and
 *      DELETEs them in batches. Each batch runs in its own transaction.
 *      Any error mid-batch rolls back the in-flight batch, writes a
 *      `failed` audit row, and aborts.
 *
 *   4. The WHERE predicate is:
 *
 *        tenant_id = 'default'
 *        AND agent_id = 'default'
 *        AND created_at < <cutoff>
 *        AND tipo IN ('reflexao')           -- see VALID_REFLECTION_TIPOS
 *
 *      We deliberately scope to ONLY reflection-typed rows. Other tipos
 *      that legitimately landed in the default bucket (e.g. an admin
 *      writing a fact under the seeded `default` tenant) are preserved.
 *
 *   5. STRUCTURAL LIMITATION — the predicate is a HEURISTIC, not a
 *      provenance check. The pre-#251 worker did NOT stamp any
 *      `created_by='reflection-batch-v1'` marker on the rows it wrote
 *      under default/default, so there is NO column we can read at
 *      cleanup time to distinguish "polluted by the buggy worker" from
 *      "legitimate reflection written under a real `default` tenant".
 *
 *      In practice this script is safe IFF the operator can answer "yes"
 *      to: "I have verified that `tenant_id='default'` is not used as a
 *      real production tenant in this environment". If `default` IS a
 *      real tenant (seed, demo, sandbox), the script will delete its
 *      legitimate reflection rows together with the polluted ones — they
 *      are indistinguishable at the row level. The backup table makes
 *      this RECOVERABLE via `--undo` but the operator still bears the
 *      responsibility for verifying scope before pressing y.
 *
 *      To force the operator to acknowledge this, `--execute` requires a
 *      paired `--accept-heuristic` flag. The flag exists ONLY as a
 *      forced acknowledgement; it does not change the SQL. Owner reviewed
 *      and accepted this heuristic explicitly on issue #260 (Option A,
 *      "hard DELETE polluted rows"); a provenance-based solution
 *      (Option A in the PR #276 review — backfill a `created_by` column)
 *      was rejected because no such column exists on the pre-#251 rows
 *      and adding one now does not help past data.
 *
 *   6. Every executed run appends MULTIPLE audit rows to `admin_audit_log`,
 *      all sharing the same `cleanup_run_id` and `action`-prefix:
 *        - action='reflection_memory_cleanup.started' — written BEFORE the
 *          first DELETE, contains cutoff + planned_count + cleanup_run_id.
 *        - action='reflection_memory_cleanup.batch_completed' — one per
 *          batch, contains batch_index + rows_deleted_in_batch + a sample
 *          of deleted IDs (cap of 50 per batch to avoid bloating jsonb).
 *        - action='reflection_memory_cleanup.completed' OR
 *          action='reflection_memory_cleanup.failed' — written AFTER
 *          either all batches succeed or the loop aborts on error. The
 *          completed row has totals; the failed row has the error message.
 *      The audit rows are the operator-visible record of the cleanup —
 *      the spec says `audit_log` but `admin_audit_log` is the purpose-built
 *      APPEND-ONLY admin-mutation table (migration 047) and `audit_log.acao`
 *      is a typed enum that doesn't include a cleanup action; admin_audit_log.action
 *      is free-form text and the right home for this.
 *
 * USAGE:
 *
 *     # Find polluted rows (dry-run, the safe default)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --dry-run
 *
 *     # Execute deletion (requires --accept-heuristic + [y/N] confirmation)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --execute --accept-heuristic
 *
 *     # Non-interactive execute (CI/cron — still requires --accept-heuristic)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --execute --accept-heuristic --yes
 *
 *     # Custom batch size (default 1000 per COMMIT)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --execute --accept-heuristic --limit=500
 *
 *     # Undo a prior cleanup run (restores all rows snapshotted under the run_id)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --undo=<cleanup_run_id>
 *
 *   The cutoff above is the merge time of PR #251 (commit 4102556a — the
 *   `reflection-batch` per-tenant context fix). Anything earlier was
 *   produced by the buggy worker; anything at or after the cutoff was
 *   produced by the fixed worker and is NOT in scope.
 *
 * EXIT CODES:
 *
 *     0  — success (counted in dry-run, deleted in execute mode, restored
 *          in undo mode)
 *     2  — usage error: missing/invalid --cutoff, conflicting flags,
 *          `--execute` without `--accept-heuristic`, cutoff > MAX_SAFE_CUTOFF,
 *          confirmation declined, or undo run not found
 *     1  — unexpected error during execution (DB failure, etc.)
 */
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// CLI args parsing
// ---------------------------------------------------------------------------

/**
 * Reflection memories are typed `tipo='reflexao'` by
 * `src/workers/reflection-batch.ts:123`. Keeping this list explicit (not a
 * wildcard) means an operator running the cleanup never accidentally drops a
 * non-reflection row that happens to be in the `default` bucket.
 */
export const VALID_REFLECTION_TIPOS = ['reflexao'] as const;
export type ValidReflectionTipo = (typeof VALID_REFLECTION_TIPOS)[number];

/**
 * The polluted bucket. Hardcoded — the script's whole purpose is to clean
 * rows that landed here due to the pre-#251 hardcoded default/default
 * context. We do NOT take these as CLI args, both because they're load-
 * bearing for the WHERE clause and because parameterising them would invite
 * a typo that wipes a real tenant.
 */
export const POLLUTED_TENANT_ID = 'default';
export const POLLUTED_AGENT_ID = 'default';

/**
 * Default batch size for the DELETE loop. Each batch runs in its own
 * transaction (`BEGIN ... COMMIT`/`ROLLBACK`) so a crash partway through
 * doesn't leave a half-deleted set. 1000 is a balance between per-batch
 * commit overhead and keeping the WAL/replication lag bounded.
 */
export const DEFAULT_BATCH_SIZE = 1000;

/**
 * HARDCODED UPPER BOUND for --cutoff.
 *
 * Codex review iter 2 on PR #276 (blocker #5, HIGH): without a hardcoded
 * upper bound, an operator could pass a cutoff later than the PR #251
 * merge time and the script would happily delete LEGITIMATE post-fix
 * reflections that landed in the race window between the per-tenant
 * worker getting deployed and the reflections that the OLD worker had
 * already enqueued but not yet processed.
 *
 * The fix is to refuse any cutoff > the actual merge timestamp of PR #251
 * (commit 4102556a). This value is the wall-clock UTC of that merge —
 * any reflection with `created_at >= MAX_SAFE_CUTOFF` was unambiguously
 * produced by the fixed worker and is NEVER in scope for this cleanup.
 *
 * If a future bug requires a different cleanup window, the operator
 * should fork this script (don't relax the bound), so the audit trail
 * remains tied to "the pre-#251 worker bug".
 */
export const MAX_SAFE_CUTOFF = new Date('2026-05-28T12:55:08Z');

/**
 * Cap on the number of deleted-row IDs we serialize into the per-batch
 * audit row's `change_summary.deleted_ids_sample`. The full ID list is
 * recoverable from `agent_memories_cleanup_backup WHERE cleanup_run_id =
 * <run_id>`; the audit sample is a forensic shortcut, not the canonical
 * trail. 50 IDs is enough to spot-check without bloating jsonb.
 */
const AUDIT_DELETED_IDS_SAMPLE_CAP = 50;

function arg(argv: string[], name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  const flag = `--${name}`;
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

export class RequiredArgsError extends Error {
  readonly code = 'MISSING_REQUIRED_ARGS';
  constructor(detail: string) {
    super(
      `reflection-memory-cleanup: ${detail}. ` +
        'usage: npx tsx scripts/reflection-memory-cleanup.ts --cutoff=<ISO_DATETIME> [--dry-run|--execute] [--limit=<N>] [--yes] [--undo=<run_id>]',
    );
    this.name = 'RequiredArgsError';
  }
}

export class InvalidArgsError extends Error {
  readonly code = 'INVALID_ARGS';
  constructor(detail: string) {
    super(`reflection-memory-cleanup: ${detail}`);
    this.name = 'InvalidArgsError';
  }
}

export type ParsedArgs = {
  cutoff: Date | null;
  cutoffRaw: string | null;
  execute: boolean;
  dryRun: boolean;
  limit: number;
  acceptHeuristic: boolean;
  yes: boolean;
  undo: string | null;
};

/**
 * Parse and validate the CLI flags. Exported so the unit tests can drive the
 * rejection contract without spawning the script in a child process.
 *
 * Validation rules:
 *   - When `--undo=<run_id>` is present, ALL other validation is skipped —
 *     undo is a separate code path that operates on a prior backup. The
 *     run_id MUST be a non-empty string (we don't constrain to UUID shape
 *     here because the in-memory dispatch in tests can use any string).
 *   - `--cutoff` is REQUIRED (unless `--undo`). Missing → `RequiredArgsError`.
 *   - `--cutoff` must parse as a valid date. Junk → `InvalidArgsError`.
 *   - `--cutoff` must NOT be in the future. A future cutoff would either
 *     delete brand-new legitimate rows or be a typo; either way it's a fail.
 *   - `--cutoff` must NOT be > MAX_SAFE_CUTOFF. Anything past the PR #251
 *     merge timestamp could sweep legitimate post-fix rows.
 *   - `--dry-run` and `--execute` are mutually exclusive. Passing both is
 *     ambiguous; fail loud.
 *   - When neither `--dry-run` nor `--execute` is present, default to
 *     dry-run (the safe option). This means a user who FORGETS `--execute`
 *     just gets a count — they don't accidentally wipe anything.
 *   - `--limit` must be a positive integer if present; defaults to
 *     `DEFAULT_BATCH_SIZE`.
 *   - `--execute` REQUIRES `--accept-heuristic`. The cleanup predicate is
 *     a heuristic (no provenance column on past rows; see file docblock
 *     section #5), so the operator MUST positively acknowledge that
 *     `tenant_id='default'` is not a real production tenant in this
 *     environment. `--execute` without `--accept-heuristic` is rejected
 *     with `RequiredArgsError`.
 *   - `--yes` skips the interactive prompt at confirm time. It is OPTIONAL
 *     and does NOT bypass `--accept-heuristic` (the two are independent
 *     gates — `--accept-heuristic` is a knowledge-acknowledgement at
 *     flag-parse time; `--yes` is a non-TTY automation convenience).
 */
export function parseArgs(
  argv: string[],
  options?: { now?: () => Date; maxSafeCutoff?: Date },
): ParsedArgs {
  // Undo path bypasses the cutoff machinery entirely.
  const undoRaw = arg(argv, 'undo');
  if (undoRaw !== undefined) {
    if (undoRaw.trim() === '') {
      throw new InvalidArgsError(
        '--undo requires a non-empty cleanup_run_id (e.g. --undo=<uuid>)',
      );
    }
    return {
      cutoff: null,
      cutoffRaw: null,
      execute: false,
      dryRun: false,
      limit: DEFAULT_BATCH_SIZE,
      acceptHeuristic: false,
      yes: hasFlag(argv, 'yes'),
      undo: undoRaw.trim(),
    };
  }

  const cutoffRaw = arg(argv, 'cutoff');
  if (!cutoffRaw) {
    throw new RequiredArgsError('missing required arg: --cutoff=<ISO_DATETIME>');
  }
  const cutoff = new Date(cutoffRaw);
  if (Number.isNaN(cutoff.getTime())) {
    throw new InvalidArgsError(
      `--cutoff value is not a valid date: "${cutoffRaw}" (use ISO 8601, e.g. 2026-05-28T12:55:08Z)`,
    );
  }
  const now = options?.now?.() ?? new Date();
  if (cutoff.getTime() > now.getTime()) {
    throw new InvalidArgsError(
      `--cutoff is in the future (cutoff=${cutoff.toISOString()} now=${now.toISOString()}). ` +
        'Refusing to delete rows newer than now.',
    );
  }
  const maxSafeCutoff = options?.maxSafeCutoff ?? MAX_SAFE_CUTOFF;
  if (cutoff.getTime() > maxSafeCutoff.getTime()) {
    throw new InvalidArgsError(
      `--cutoff is later than MAX_SAFE_CUTOFF (${maxSafeCutoff.toISOString()} — the PR #251 ` +
        'merge timestamp). Anything past that point could be a legitimate post-fix reflection. ' +
        'If you need a different window, fork this script — do not relax this bound. ' +
        `Got cutoff=${cutoff.toISOString()}.`,
    );
  }

  const execute = hasFlag(argv, 'execute');
  const dryRunFlag = hasFlag(argv, 'dry-run');
  if (execute && dryRunFlag) {
    throw new InvalidArgsError(
      'cannot pass both --execute and --dry-run; pick one (dry-run is the default)',
    );
  }
  // Default to dry-run when neither flag is present.
  const dryRun = !execute;

  const acceptHeuristic = hasFlag(argv, 'accept-heuristic');
  if (execute && !acceptHeuristic) {
    throw new RequiredArgsError(
      '--execute requires --accept-heuristic. The cleanup predicate is a ' +
        "heuristic, not a provenance check: rows are matched by (tenant='default', " +
        "agent='default', tipo='reflexao', created_at<cutoff), which is " +
        'indistinguishable from a legitimate reflection written under a real ' +
        "`default` tenant. Pass --accept-heuristic to acknowledge you have " +
        "verified that `tenant_id='default'` is NOT a real production tenant in " +
        'this environment. See the file docblock (section #5) for details.',
    );
  }

  const limitRaw = arg(argv, 'limit');
  let limit = DEFAULT_BATCH_SIZE;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgsError(
        `--limit must be a positive integer, got "${limitRaw}"`,
      );
    }
    limit = parsed;
  }

  const yes = hasFlag(argv, 'yes');

  return {
    cutoff,
    cutoffRaw,
    execute,
    dryRun,
    limit,
    acceptHeuristic,
    yes,
    undo: null,
  };
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'usage: npx tsx scripts/reflection-memory-cleanup.ts --cutoff=<ISO_DATETIME> [--dry-run|--execute --accept-heuristic] [--limit=<N>] [--yes] [--undo=<run_id>]',
  );
  console.error('');
  console.error('  --cutoff=<ISO>        REQUIRED (unless --undo). Rows with created_at < cutoff are in scope.');
  console.error('                        Recommended: PR #251 merge time (2026-05-28T12:55:08Z).');
  console.error('                        Hard upper bound: MAX_SAFE_CUTOFF (' + MAX_SAFE_CUTOFF.toISOString() + ').');
  console.error('  --dry-run             DEFAULT. Count and sample, do NOT delete.');
  console.error('  --execute             Destructive. Snapshots in-scope rows to');
  console.error('                        agent_memories_cleanup_backup, then deletes.');
  console.error('                        Prompts [y/N] unless --yes is passed.');
  console.error('  --accept-heuristic    REQUIRED with --execute. Acknowledges that the');
  console.error('                        predicate is heuristic (no provenance marker on');
  console.error("                        past rows) and that tenant_id='default' is NOT");
  console.error('                        a real production tenant in this environment.');
  console.error('  --yes                 Skip the [y/N] confirmation prompt. Use for non-TTY');
  console.error('                        automation (CI, cron). Does NOT bypass --accept-heuristic.');
  console.error('  --undo=<run_id>       Restore rows from a prior cleanup run, byte-identical');
  console.error('                        to their pre-delete state. Idempotent: rerunning --undo');
  console.error('                        for a run that has already been restored is a no-op.');
  console.error('  --limit=<N>           Batch size for DELETE loop. Default: ' + DEFAULT_BATCH_SIZE + '.');
  console.error('');
  console.error('See file header docblock for the full contract (issue #260).');
}

// ---------------------------------------------------------------------------
// Query helpers (exported for tests)
// ---------------------------------------------------------------------------

export type ScopeSummary = {
  count: number;
  earliestCreatedAt: string | null;
  latestCreatedAt: string | null;
  sample: Array<{ id: string; created_at: string; tipo: string; conteudo: string }>;
  remainingDefaultDefault: number;
};

const SAMPLE_SIZE = 5;
const SAMPLE_TRUNCATE_CHARS = 80;

/**
 * Compute the dry-run summary for a given cutoff. Always runs in read-only
 * mode — no INSERT/UPDATE/DELETE. Returns counts + a 5-row sample with the
 * `conteudo` truncated for log readability.
 *
 * `remainingDefaultDefault` is the post-cleanup expectation: the count of
 * rows in `(tenant='default', agent='default')` that would REMAIN after a
 * full DELETE. It includes rows that fail any of the in-scope predicates
 * (e.g. created_at >= cutoff, or tipo != 'reflexao'). Useful for an
 * operator sanity-checking what would survive.
 */
export async function summarizeScope(args: {
  cutoff: Date;
  tipos?: readonly string[];
}): Promise<ScopeSummary> {
  const tipos = args.tipos ?? VALID_REFLECTION_TIPOS;
  // We pass the cutoff as an ISO string and let Postgres cast it via the
  // `timestamptz` column — explicit and timezone-safe.
  const cutoffIso = args.cutoff.toISOString();

  const countResult = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM agent_memories
    WHERE tenant_id = ${POLLUTED_TENANT_ID}
      AND agent_id = ${POLLUTED_AGENT_ID}
      AND created_at < ${cutoffIso}::timestamptz
      AND tipo = ANY(${tipos as unknown as string[]})
  `);
  const count = Number(
    (countResult.rows[0] as { count: string } | undefined)?.count ?? 0,
  );

  const rangeResult = await db.execute<{
    earliest: string | null;
    latest: string | null;
  }>(sql`
    SELECT
      min(created_at)::text AS earliest,
      max(created_at)::text AS latest
    FROM agent_memories
    WHERE tenant_id = ${POLLUTED_TENANT_ID}
      AND agent_id = ${POLLUTED_AGENT_ID}
      AND created_at < ${cutoffIso}::timestamptz
      AND tipo = ANY(${tipos as unknown as string[]})
  `);
  const rangeRow = rangeResult.rows[0] as
    | { earliest: string | null; latest: string | null }
    | undefined;

  const sampleResult = await db.execute<{
    id: string;
    created_at: string;
    tipo: string;
    conteudo: string;
  }>(sql`
    SELECT id::text, created_at::text, tipo, conteudo
    FROM agent_memories
    WHERE tenant_id = ${POLLUTED_TENANT_ID}
      AND agent_id = ${POLLUTED_AGENT_ID}
      AND created_at < ${cutoffIso}::timestamptz
      AND tipo = ANY(${tipos as unknown as string[]})
    ORDER BY created_at
    LIMIT ${SAMPLE_SIZE}
  `);
  const sample = sampleResult.rows.map((r) => {
    const row = r as { id: string; created_at: string; tipo: string; conteudo: string };
    return {
      id: row.id,
      created_at: row.created_at,
      tipo: row.tipo,
      conteudo:
        row.conteudo.length > SAMPLE_TRUNCATE_CHARS
          ? `${row.conteudo.slice(0, SAMPLE_TRUNCATE_CHARS)}…`
          : row.conteudo,
    };
  });

  const remainingResult = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM agent_memories
    WHERE tenant_id = ${POLLUTED_TENANT_ID}
      AND agent_id = ${POLLUTED_AGENT_ID}
  `);
  const remainingDefaultDefault =
    Number(
      (remainingResult.rows[0] as { count: string } | undefined)?.count ?? 0,
    ) - count;

  return {
    count,
    earliestCreatedAt: rangeRow?.earliest ?? null,
    latestCreatedAt: rangeRow?.latest ?? null,
    sample,
    remainingDefaultDefault,
  };
}

/**
 * Snapshot the in-scope rows into `agent_memories_cleanup_backup` BEFORE
 * the DELETE. Returns the count snapshotted — the script then deletes the
 * SAME `original_id` set (via the second query in this module) instead of
 * re-evaluating the predicate per batch (Codex blocker #6: race window).
 *
 * Runs inside an open transaction (the caller `deleteInScope` is
 * responsible for BEGIN/COMMIT). The snapshot is appended atomically with
 * the first batch's DELETE.
 *
 * Exported for tests so they can assert the snapshot rows directly.
 */
export async function snapshotInScope(args: {
  cutoff: Date;
  cleanupRunId: string;
  executedByUser: string;
  tipos?: readonly string[];
}): Promise<{ snapshottedCount: number; snapshottedIds: string[] }> {
  const tipos = args.tipos ?? VALID_REFLECTION_TIPOS;
  const cutoffIso = args.cutoff.toISOString();
  // `RETURNING original_id` lets us capture the frozen ID list in one
  // round-trip — no separate SELECT pass that could observe a different
  // view of the table than the INSERT.
  const result = await db.execute<{ original_id: string }>(sql`
    INSERT INTO agent_memories_cleanup_backup (
      cleanup_run_id,
      original_id,
      tenant_id,
      agent_id,
      conteudo,
      embedding,
      tipo,
      escopo,
      metadata,
      ref_tabela,
      ref_id,
      original_created_at,
      deleted_by
    )
    SELECT
      ${args.cleanupRunId}::uuid AS cleanup_run_id,
      id AS original_id,
      tenant_id,
      agent_id,
      conteudo,
      embedding,
      tipo,
      escopo,
      metadata,
      ref_tabela,
      ref_id,
      created_at AS original_created_at,
      ${args.executedByUser} AS deleted_by
    FROM agent_memories
    WHERE tenant_id = ${POLLUTED_TENANT_ID}
      AND agent_id = ${POLLUTED_AGENT_ID}
      AND created_at < ${cutoffIso}::timestamptz
      AND tipo = ANY(${tipos as unknown as string[]})
    RETURNING original_id::text
  `);
  const snapshottedIds = (result.rows as Array<{ original_id: string }>).map(
    (r) => r.original_id,
  );
  return { snapshottedCount: snapshottedIds.length, snapshottedIds };
}

export type DeleteResult = {
  rowsDeleted: number;
  batches: number;
  startedAt: string;
  endedAt: string;
  cleanupRunId: string;
  snapshottedIds: string[];
};

/**
 * Run the snapshot-then-batched-DELETE for in-scope rows.
 *
 * NEW SEQUENCE (PR #276 iter 2):
 *
 *   1. Generate `cleanupRunId` (caller-side; see `runExecute`).
 *   2. BEGIN — snapshot transaction.
 *   3. INSERT INTO agent_memories_cleanup_backup SELECT FROM agent_memories
 *      WHERE <predicate> RETURNING original_id.
 *      This FREEZES the candidate set: every subsequent DELETE matches
 *      `id IN (snapshotted_ids)` instead of re-evaluating the predicate.
 *   4. COMMIT — snapshot now durable. Operator can `--undo` from this
 *      point on.
 *   5. For each batch of `batchSize` snapshotted IDs:
 *        BEGIN
 *        DELETE FROM agent_memories WHERE id IN (batch_ids)
 *        AUDIT batch_completed (caller writes after COMMIT)
 *        COMMIT — on error, ROLLBACK, write `failed` audit, throw.
 *   6. Loop terminates when the ID list is exhausted.
 *
 * Why snapshot is its own transaction:
 *   - Keeps the snapshot durable even if a delete batch fails.
 *   - Operator can `--undo=<cleanupRunId>` at any point (snapshot rows
 *     are still in the backup table; the DELETE rolled them off
 *     agent_memories, the INSERT path of --undo puts them back).
 *
 * Why DELETE matches on `id IN (...)` and not the predicate:
 *   - Codex blocker #6: between snapshot-time and per-batch DELETE, a
 *     concurrent INSERT could land a NEW row matching the predicate.
 *     Re-evaluating per batch would silently sweep that NEW row, even
 *     though the operator confirmed only the snapshot count.
 *   - Matching on `id IN` ensures the delete set == the snapshot set.
 *
 * Exported for tests so they can drive the production code path without
 * argv parsing or the readline prompt.
 */
export async function deleteInScope(args: {
  cutoff: Date;
  batchSize?: number;
  tipos?: readonly string[];
  executedByUser: string;
  cleanupRunId?: string;
  log?: (msg: string) => void;
  onBatchCompleted?: (batchInfo: {
    batchIndex: number;
    deletedIds: string[];
    rowsDeletedInBatch: number;
    rowsDeletedTotal: number;
  }) => Promise<void>;
}): Promise<DeleteResult> {
  const tipos = args.tipos ?? VALID_REFLECTION_TIPOS;
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = args.log ?? (() => undefined);
  const cleanupRunId = args.cleanupRunId ?? randomUUID();
  const startedAt = new Date().toISOString();

  // ---- Phase 1: snapshot in its own transaction ----
  log(`  snapshotting in-scope rows into agent_memories_cleanup_backup (run_id=${cleanupRunId})...`);
  let snapshottedIds: string[];
  let snapshotStarted = false;
  try {
    await db.execute(sql`BEGIN`);
    snapshotStarted = true;
    const snap = await snapshotInScope({
      cutoff: args.cutoff,
      cleanupRunId,
      executedByUser: args.executedByUser,
      tipos,
    });
    snapshottedIds = snap.snapshottedIds;
    await db.execute(sql`COMMIT`);
    snapshotStarted = false;
  } catch (err) {
    if (snapshotStarted) {
      try {
        await db.execute(sql`ROLLBACK`);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
  log(`  snapshotted ${snapshottedIds.length} row(s); proceeding to batched DELETE on frozen ID set.`);

  // ---- Phase 2: batched DELETE against the frozen ID set ----
  let rowsDeleted = 0;
  let batches = 0;
  for (let cursor = 0; cursor < snapshottedIds.length; cursor += batchSize) {
    const batchIds = snapshottedIds.slice(cursor, cursor + batchSize);
    if (batchIds.length === 0) break;
    let batchDeleted: number;
    let transactionStarted = false;
    try {
      await db.execute(sql`BEGIN`);
      transactionStarted = true;
      // `id IN (...)` against the FROZEN snapshot. Concurrent inserts
      // landing a new in-predicate row CANNOT enter this delete set.
      const deleteResult = await db.execute(sql`
        DELETE FROM agent_memories
        WHERE id = ANY(${batchIds as unknown as string[]}::uuid[])
      `);
      // `pg` driver exposes the number affected as `rowCount`. Cast
      // through unknown to avoid leaking the driver's full type signature.
      batchDeleted = Number(
        (deleteResult as unknown as { rowCount?: number }).rowCount ?? 0,
      );
      await db.execute(sql`COMMIT`);
      transactionStarted = false;
    } catch (err) {
      if (transactionStarted) {
        try {
          await db.execute(sql`ROLLBACK`);
        } catch {
          // best-effort rollback; original error is what matters
        }
      }
      throw err;
    }

    if (batchDeleted === 0 && batchIds.length > 0) {
      // The frozen ID set predicted N rows but DELETE matched 0 — the
      // rows must have been removed by something else between snapshot
      // and DELETE. Not an error per se (the goal of "row no longer
      // exists" IS achieved), but worth logging.
      log(
        `  batch ${batches + 1}: 0 rows deleted (expected ${batchIds.length}; row(s) may have been removed by another process between snapshot and DELETE)`,
      );
    }
    rowsDeleted += batchDeleted;
    batches++;
    log(`  batch ${batches}: deleted ${batchDeleted} (running total: ${rowsDeleted})`);
    if (args.onBatchCompleted) {
      await args.onBatchCompleted({
        batchIndex: batches,
        deletedIds: batchIds,
        rowsDeletedInBatch: batchDeleted,
        rowsDeletedTotal: rowsDeleted,
      });
    }
  }

  const endedAt = new Date().toISOString();
  return { rowsDeleted, batches, startedAt, endedAt, cleanupRunId, snapshottedIds };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type CleanupAuditAction =
  | 'reflection_memory_cleanup.started'
  | 'reflection_memory_cleanup.batch_completed'
  | 'reflection_memory_cleanup.completed'
  | 'reflection_memory_cleanup.failed';

/**
 * Append an `admin_audit_log` row recording a phase of the executed cleanup.
 *
 * The function is intentionally a thin wrapper around the INSERT so the
 * caller can interleave audit writes with the DELETE loop. Each phase has
 * its own change_summary shape — see `CleanupAuditAction` and the call
 * sites in `runExecute` for the canonical payload per action.
 *
 * Why `admin_audit_log` and not `audit_log`:
 *   - `audit_log.acao` is a typed enum (`AuditAction`) that does NOT include
 *     a cleanup action and we don't want to expand the user-facing typed
 *     vocabulary for one-off admin scripts.
 *   - `admin_audit_log` (migration 047) is APPEND-ONLY by contract, its
 *     `action` column is free-form text, and it has `change_summary` JSON
 *     for exactly this kind of structured payload. It already serves
 *     admin-ui mutations — a script-driven mutation is the same shape.
 *
 * Run under `runWithTenantContext({tenant_id:'system', agent_id:'system'})`
 * so any ALS-reading code sees a non-default context; the row's `tenant_id`
 * column is set explicitly to 'default' because the dispatch spec says the
 * audit row belongs to the cleanup of the default bucket.
 *
 * Exported for tests.
 */
export async function appendAuditRow(args: {
  action: CleanupAuditAction;
  executedByUser: string;
  changeSummary: Record<string, unknown>;
  cleanupRunId: string;
}): Promise<void> {
  // Embed the run id in the resource_id column so SQL joins on
  // (admin_audit_log.resource_id == agent_memories_cleanup_backup.cleanup_run_id)
  // are direct (avoids digging into change_summary jsonb).
  await db.execute(sql`
    INSERT INTO admin_audit_log (tenant_id, actor_id, actor_role, action, resource_type, resource_id, change_summary)
    VALUES (
      ${'default'},
      ${args.executedByUser},
      ${'script'},
      ${args.action},
      ${'agent_memories'},
      ${args.cleanupRunId},
      ${JSON.stringify(args.changeSummary)}::jsonb
    )
  `);
}

// ---------------------------------------------------------------------------
// Undo path (--undo=<cleanup_run_id>)
// ---------------------------------------------------------------------------

export type UndoResult = {
  cleanupRunId: string;
  rowsRestored: number;
  rowsAlreadyRestored: number;
  rowsSkippedConflict: number;
  rowsTotalInBackup: number;
};

/**
 * Restore rows snapshotted under `cleanupRunId` from the backup table
 * back into `agent_memories`. Idempotent:
 *   - rows with `restored_at IS NOT NULL` are skipped.
 *   - rows whose `original_id` already exists in `agent_memories` (e.g. a
 *     previous --undo + new INSERT under the same UUID) are skipped via
 *     `ON CONFLICT (id) DO NOTHING`.
 * Both cases are reported separately so the operator can spot anomalies.
 *
 * Exported for tests.
 */
export async function undoCleanup(args: {
  cleanupRunId: string;
  executedByUser: string;
  log?: (msg: string) => void;
}): Promise<UndoResult> {
  const log = args.log ?? (() => undefined);

  // 1. Count what's in the backup for this run (sanity check).
  const totalResult = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM agent_memories_cleanup_backup
    WHERE cleanup_run_id = ${args.cleanupRunId}::uuid
  `);
  const rowsTotalInBackup = Number(
    (totalResult.rows[0] as { count: string } | undefined)?.count ?? 0,
  );
  if (rowsTotalInBackup === 0) {
    log(`No backup rows found for cleanup_run_id=${args.cleanupRunId}. Nothing to restore.`);
    return {
      cleanupRunId: args.cleanupRunId,
      rowsRestored: 0,
      rowsAlreadyRestored: 0,
      rowsSkippedConflict: 0,
      rowsTotalInBackup: 0,
    };
  }

  // 2. Count already-restored.
  const alreadyResult = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM agent_memories_cleanup_backup
    WHERE cleanup_run_id = ${args.cleanupRunId}::uuid
      AND restored_at IS NOT NULL
  `);
  const rowsAlreadyRestored = Number(
    (alreadyResult.rows[0] as { count: string } | undefined)?.count ?? 0,
  );

  // 3. INSERT ... SELECT FROM backup WHERE restored_at IS NULL
  //    ON CONFLICT (id) DO NOTHING — preserves the original row PK so
  //    refs to the UUID stay valid. The conflict path triggers when a
  //    row with the same UUID was inserted between cleanup and undo
  //    (rare but possible if a process re-uses the UUID; we choose
  //    NOT to clobber to be safe).
  await db.execute(sql`BEGIN`);
  // Assigned unconditionally inside the try (restore count + conflict math)
  // before any read; the catch always rethrows, so reaching the code after
  // the try/catch implies both were set. No initializer (would be a dead
  // assignment flagged by no-useless-assignment).
  let rowsRestored: number;
  let rowsSkippedConflict: number;
  try {
    const restoreResult = await db.execute<{ id: string }>(sql`
      INSERT INTO agent_memories (
        id, tenant_id, agent_id, conteudo, embedding, tipo, escopo,
        metadata, ref_tabela, ref_id, created_at
      )
      SELECT
        original_id, tenant_id, agent_id, conteudo, embedding, tipo, escopo,
        metadata, ref_tabela, ref_id, original_created_at
      FROM agent_memories_cleanup_backup
      WHERE cleanup_run_id = ${args.cleanupRunId}::uuid
        AND restored_at IS NULL
      ON CONFLICT (id) DO NOTHING
      RETURNING id::text
    `);
    rowsRestored = (restoreResult.rows as Array<{ id: string }>).length;
    const restoredIds = (restoreResult.rows as Array<{ id: string }>).map((r) => r.id);

    // Mark restored rows. We use the returned IDs so we ONLY mark rows
    // that actually re-entered agent_memories (the ON CONFLICT path
    // does not return; those rows correctly stay restored_at IS NULL
    // until the operator resolves the conflict).
    if (restoredIds.length > 0) {
      await db.execute(sql`
        UPDATE agent_memories_cleanup_backup
        SET restored_at = now()
        WHERE cleanup_run_id = ${args.cleanupRunId}::uuid
          AND original_id = ANY(${restoredIds as unknown as string[]}::uuid[])
      `);
    }

    // Count conflicts = (rows that needed restore) - (rows actually
    // inserted). The "needed restore" universe is rowsTotalInBackup -
    // rowsAlreadyRestored.
    rowsSkippedConflict =
      rowsTotalInBackup - rowsAlreadyRestored - rowsRestored;
    if (rowsSkippedConflict < 0) rowsSkippedConflict = 0;

    await db.execute(sql`COMMIT`);
  } catch (err) {
    try {
      await db.execute(sql`ROLLBACK`);
    } catch {
      // best-effort
    }
    throw err;
  }

  // 4. Audit the undo.
  await appendAuditRow({
    action: 'reflection_memory_cleanup.completed', // re-using completed; payload distinguishes
    executedByUser: args.executedByUser,
    cleanupRunId: args.cleanupRunId,
    changeSummary: {
      phase: 'undo',
      cleanup_run_id: args.cleanupRunId,
      rows_restored: rowsRestored,
      rows_already_restored: rowsAlreadyRestored,
      rows_skipped_conflict: rowsSkippedConflict,
      rows_total_in_backup: rowsTotalInBackup,
      executed_by_user: args.executedByUser,
      script: 'scripts/reflection-memory-cleanup.ts',
      issue: 260,
    },
  });

  return {
    cleanupRunId: args.cleanupRunId,
    rowsRestored,
    rowsAlreadyRestored,
    rowsSkippedConflict,
    rowsTotalInBackup,
  };
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

/**
 * Ask the operator to confirm the destructive run. Fail-closed:
 *   - empty input → NO (the user just hit enter without thinking)
 *   - anything that doesn't start with 'y'/'Y' → NO
 *   - the readline closing without input (e.g. piped from /dev/null) → NO
 *
 * Exported for tests so they can drive the path without spawning a real TTY;
 * the option bag accepts a custom reader that returns the response string.
 */
export async function confirmDestructive(args: {
  prompt: string;
  reader?: () => Promise<string>;
}): Promise<boolean> {
  const reader = args.reader ?? defaultReader;
  const answer = await reader();
  const trimmed = (answer ?? '').trim().toLowerCase();
  return trimmed === 'y' || trimmed === 'yes';
}

function defaultReader(): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Are you sure? [y/N] ', (a) => {
      rl.close();
      resolve(a);
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * Execute the dry-run path: summarize, print, exit.
 * Exported so tests can run it without going through `main()`.
 */
export async function runDryRun(args: {
  cutoff: Date;
  log?: (msg: string) => void;
}): Promise<ScopeSummary> {
  const log = args.log ?? ((m: string) => console.log(m));
  log('--- DRY RUN ---');
  log(`scope: tenant_id='${POLLUTED_TENANT_ID}' agent_id='${POLLUTED_AGENT_ID}'`);
  log(`cutoff (created_at <): ${args.cutoff.toISOString()}`);
  log(`tipos: ${VALID_REFLECTION_TIPOS.join(',')}`);
  const summary = await runWithTenantContext(
    { tenant_id: POLLUTED_TENANT_ID, agent_id: POLLUTED_AGENT_ID },
    () => summarizeScope({ cutoff: args.cutoff }),
  );
  log(`rows in scope (would be deleted): ${summary.count}`);
  log(`earliest created_at: ${summary.earliestCreatedAt ?? '(none)'}`);
  log(`latest created_at:   ${summary.latestCreatedAt ?? '(none)'}`);
  log(
    `rows in (tenant='default', agent='default') that would REMAIN after delete: ${summary.remainingDefaultDefault}`,
  );
  if (summary.sample.length === 0) {
    log('sample: (no matching rows)');
  } else {
    log(`sample (first ${summary.sample.length} by created_at):`);
    for (const s of summary.sample) {
      log(`  id=${s.id} created_at=${s.created_at} tipo=${s.tipo} conteudo="${s.conteudo}"`);
    }
  }
  log('--- DRY RUN END (no rows mutated) ---');
  return summary;
}

/**
 * Execute the destructive path: confirm, snapshot, delete, audit, print.
 *
 * Audit sequence (PR #276 iter 2 — Codex blocker #2 resolution):
 *   - Compute the dry-run summary so the operator sees the count.
 *   - Print the heuristic warning.
 *   - Confirm (or skip via --yes).
 *   - WRITE AUDIT `started` (with cleanupRunId, planned_count, agent_id) —
 *     BEFORE any delete. If we crash after this, the audit trail proves
 *     the cleanup was initiated.
 *   - Run `deleteInScope` which:
 *       - snapshots to agent_memories_cleanup_backup (in its own tx),
 *       - runs N batched DELETEs against the frozen ID set,
 *       - calls back with each batch's deleted IDs.
 *   - For each batch callback, WRITE AUDIT `batch_completed` (with
 *     batch_index, deleted IDs sample).
 *   - On success, WRITE AUDIT `completed` (with totals).
 *   - On error, WRITE AUDIT `failed` (with error message) then re-throw.
 *
 * Exported so tests can drive it with a stubbed confirmation reader.
 */
export async function runExecute(args: {
  cutoff: Date;
  batchSize?: number;
  executedByUser: string;
  confirmReader?: () => Promise<string>;
  yes?: boolean;
  log?: (msg: string) => void;
  cleanupRunId?: string;
}): Promise<{ confirmed: boolean; result: DeleteResult | null; cleanupRunId: string | null }> {
  const log = args.log ?? ((m: string) => console.log(m));
  // Always print the dry-run summary first so the operator sees what will
  // be deleted BEFORE answering the prompt. This is the second safety belt
  // (the first is the explicit `--execute` flag).
  const preSummary = await runWithTenantContext(
    { tenant_id: POLLUTED_TENANT_ID, agent_id: POLLUTED_AGENT_ID },
    () => summarizeScope({ cutoff: args.cutoff }),
  );
  log('--- EXECUTE (DESTRUCTIVE) ---');
  log(`scope: tenant_id='${POLLUTED_TENANT_ID}' agent_id='${POLLUTED_AGENT_ID}'`);
  log(`cutoff (created_at <): ${args.cutoff.toISOString()}`);
  log(`tipos: ${VALID_REFLECTION_TIPOS.join(',')}`);
  log(`rows that WILL be deleted: ${preSummary.count}`);
  log(`earliest created_at: ${preSummary.earliestCreatedAt ?? '(none)'}`);
  log(`latest created_at:   ${preSummary.latestCreatedAt ?? '(none)'}`);

  if (preSummary.count === 0) {
    log('Nothing to delete. Exiting cleanly.');
    return {
      confirmed: true,
      result: {
        rowsDeleted: 0,
        batches: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        cleanupRunId: args.cleanupRunId ?? randomUUID(),
        snapshottedIds: [],
      },
      cleanupRunId: null,
    };
  }

  // HEURISTIC WARNING — printed loud, every execute run, so the operator
  // re-reads it AT confirm time, not just at flag-parse time. The flag-time
  // check (parseArgs) catches the missing acknowledgement; this line keeps
  // the limitation in front of the operator even with the flag set.
  log('');
  log('!!! HEURISTIC WARNING !!!');
  log("The cleanup predicate matches rows by (tenant='default', agent='default',");
  log("tipo='reflexao', created_at<cutoff) — there is NO provenance marker on the");
  log("pre-#251 rows. If `tenant_id='default'` is a real production tenant in this");
  log('environment, this DELETE will remove its legitimate reflections together with');
  log('the polluted ones. They are indistinguishable at the row level.');
  log('');
  log('Backup safety net: every deleted row is snapshotted into');
  log("`agent_memories_cleanup_backup` BEFORE delete. Run with --undo=<run_id> to");
  log('restore. The cleanup_run_id is printed below and written to admin_audit_log.');
  log('');
  log('You passed --accept-heuristic; by answering [y] below you are confirming AGAIN');
  log("that `default` is not a real tenant here. See issue #260 + file docblock #5.");
  log('');

  const confirmed = args.yes
    ? true
    : await confirmDestructive({
        prompt: 'Are you sure? [y/N] ',
        reader: args.confirmReader,
      });
  if (args.yes) {
    log('--yes flag passed; skipping interactive confirmation.');
  }
  if (!confirmed) {
    log('Confirmation declined. No rows mutated.');
    return { confirmed: false, result: null, cleanupRunId: null };
  }

  // Pre-generate the cleanup_run_id so the AUDIT-STARTED row can carry it
  // BEFORE the first delete (Codex blocker #2 — audit before mutation).
  const cleanupRunId = args.cleanupRunId ?? randomUUID();
  log(`cleanup_run_id: ${cleanupRunId}`);

  // ---- AUDIT: started — BEFORE any mutation ----
  // If we crash after this point but before any DELETE, this row alone
  // tells an operator "a cleanup was initiated against this bucket; check
  // agent_memories_cleanup_backup for any partial snapshot".
  const auditStarted = {
    phase: 'started',
    cleanup_run_id: cleanupRunId,
    cutoff: args.cutoff.toISOString(),
    tenant_id: POLLUTED_TENANT_ID,
    agent_id: POLLUTED_AGENT_ID,
    tipos: [...VALID_REFLECTION_TIPOS],
    planned_count: preSummary.count,
    executed_by_user: args.executedByUser,
    started_at: new Date().toISOString(),
    script: 'scripts/reflection-memory-cleanup.ts',
    issue: 260,
    pr_fix_reference: '4102556a (#251)',
  };
  await runWithTenantContext(
    { tenant_id: 'system', agent_id: 'system' },
    () =>
      appendAuditRow({
        action: 'reflection_memory_cleanup.started',
        executedByUser: args.executedByUser,
        cleanupRunId,
        changeSummary: auditStarted,
      }),
  );

  let result: DeleteResult;
  try {
    result = await runWithTenantContext(
      { tenant_id: POLLUTED_TENANT_ID, agent_id: POLLUTED_AGENT_ID },
      () =>
        deleteInScope({
          cutoff: args.cutoff,
          batchSize: args.batchSize,
          executedByUser: args.executedByUser,
          cleanupRunId,
          log,
          onBatchCompleted: async (batchInfo) => {
            // Per-batch audit row. We trim the deleted_ids list to a cap
            // so the jsonb column doesn't bloat on huge cleanups — the
            // full ID list is always recoverable from the backup table.
            const idsSample = batchInfo.deletedIds.slice(0, AUDIT_DELETED_IDS_SAMPLE_CAP);
            await runWithTenantContext(
              { tenant_id: 'system', agent_id: 'system' },
              () =>
                appendAuditRow({
                  action: 'reflection_memory_cleanup.batch_completed',
                  executedByUser: args.executedByUser,
                  cleanupRunId,
                  changeSummary: {
                    phase: 'batch_completed',
                    cleanup_run_id: cleanupRunId,
                    batch_index: batchInfo.batchIndex,
                    rows_deleted_in_batch: batchInfo.rowsDeletedInBatch,
                    rows_deleted_total: batchInfo.rowsDeletedTotal,
                    deleted_ids_count: batchInfo.deletedIds.length,
                    deleted_ids_sample: idsSample,
                    deleted_ids_sample_truncated:
                      batchInfo.deletedIds.length > AUDIT_DELETED_IDS_SAMPLE_CAP,
                    tenant_id: POLLUTED_TENANT_ID,
                    agent_id: POLLUTED_AGENT_ID,
                    executed_by_user: args.executedByUser,
                    issue: 260,
                  },
                }),
            );
          },
        }),
    );
  } catch (err) {
    // ---- AUDIT: failed ----
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await runWithTenantContext(
        { tenant_id: 'system', agent_id: 'system' },
        () =>
          appendAuditRow({
            action: 'reflection_memory_cleanup.failed',
            executedByUser: args.executedByUser,
            cleanupRunId,
            changeSummary: {
              phase: 'failed',
              cleanup_run_id: cleanupRunId,
              cutoff: args.cutoff.toISOString(),
              tenant_id: POLLUTED_TENANT_ID,
              agent_id: POLLUTED_AGENT_ID,
              error_message: errorMessage,
              executed_by_user: args.executedByUser,
              failed_at: new Date().toISOString(),
              issue: 260,
            },
          }),
      );
    } catch (auditErr) {
      // We've already failed; the audit-failed write also failing is
      // logged but does not mask the original error.
      log(`WARNING: failed to write audit failure row: ${String(auditErr)}`);
    }
    throw err;
  }

  log(`deleted ${result.rowsDeleted} rows in ${result.batches} batch(es)`);

  // ---- AUDIT: completed ----
  await runWithTenantContext(
    { tenant_id: 'system', agent_id: 'system' },
    () =>
      appendAuditRow({
        action: 'reflection_memory_cleanup.completed',
        executedByUser: args.executedByUser,
        cleanupRunId,
        changeSummary: {
          phase: 'completed',
          cleanup_run_id: cleanupRunId,
          cutoff: args.cutoff.toISOString(),
          tenant_id: POLLUTED_TENANT_ID,
          agent_id: POLLUTED_AGENT_ID,
          rows_deleted: result.rowsDeleted,
          rows_snapshotted: result.snapshottedIds.length,
          batches: result.batches,
          executed_by_user: args.executedByUser,
          started_at: result.startedAt,
          ended_at: result.endedAt,
          script: 'scripts/reflection-memory-cleanup.ts',
          issue: 260,
          pr_fix_reference: '4102556a (#251)',
        },
      }),
  );
  log('audit row appended to admin_audit_log.');

  // Post-delete count in the same bucket — what's left?
  const postSummary = await runWithTenantContext(
    { tenant_id: POLLUTED_TENANT_ID, agent_id: POLLUTED_AGENT_ID },
    () => summarizeScope({ cutoff: args.cutoff }),
  );
  log(
    `remaining rows in (tenant='default', agent='default'): ${
      postSummary.remainingDefaultDefault
    } (in-scope still matching: ${postSummary.count})`,
  );
  log(`undo command: npx tsx scripts/reflection-memory-cleanup.ts --undo=${cleanupRunId}`);
  log('--- EXECUTE END ---');
  return { confirmed: true, result, cleanupRunId };
}

/**
 * Execute the undo path: restore rows from the backup table.
 * Exported so tests can drive it without argv parsing.
 */
export async function runUndo(args: {
  cleanupRunId: string;
  executedByUser: string;
  log?: (msg: string) => void;
}): Promise<UndoResult> {
  const log = args.log ?? ((m: string) => console.log(m));
  log('--- UNDO ---');
  log(`cleanup_run_id: ${args.cleanupRunId}`);
  const result = await runWithTenantContext(
    { tenant_id: 'system', agent_id: 'system' },
    () =>
      undoCleanup({
        cleanupRunId: args.cleanupRunId,
        executedByUser: args.executedByUser,
        log,
      }),
  );
  log(`rows_total_in_backup:   ${result.rowsTotalInBackup}`);
  log(`rows_restored:          ${result.rowsRestored}`);
  log(`rows_already_restored:  ${result.rowsAlreadyRestored}`);
  log(`rows_skipped_conflict:  ${result.rowsSkippedConflict}`);
  log('--- UNDO END ---');
  return result;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof RequiredArgsError || err instanceof InvalidArgsError) {
      printUsage(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // Resolve the operator identity for the audit row. `USER` (or
  // `USERNAME` on Windows) is the standard env-var; fall back to a stable
  // sentinel rather than 'unknown' so we never write an empty string.
  const executedByUser =
    process.env.USER ?? process.env.USERNAME ?? 'unknown-operator';

  if (parsed.undo) {
    await runUndo({ cleanupRunId: parsed.undo, executedByUser });
    process.exit(0);
  }

  if (parsed.dryRun) {
    // cutoff is guaranteed non-null when not in undo mode (parseArgs).
    await runDryRun({ cutoff: parsed.cutoff! });
    process.exit(0);
  }

  const outcome = await runExecute({
    cutoff: parsed.cutoff!,
    batchSize: parsed.limit,
    executedByUser,
    yes: parsed.yes,
  });
  // Confirmation-declined is a deliberate operator choice; exit 2 to make
  // it distinguishable from "succeeded with zero deletes" (which is exit 0).
  process.exit(outcome.confirmed ? 0 : 2);
}

// Only execute the CLI entry when invoked directly (e.g. `tsx
// scripts/reflection-memory-cleanup.ts`). Imports from tests must NOT
// trigger the side-effecting main() — they exercise the exported helpers
// in isolation. Same pattern as scripts/embeddings-rebuild.ts.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(`file://${entry.replace(/\\/g, '/')}`).href;
    return url === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly && !process.env.REFLECTION_CLEANUP_NO_MAIN) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
