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
 * CONTRACT (mirrors `scripts/embeddings-rebuild.ts` from #244):
 *
 *   1. REQUIRES `--cutoff=<ISO_DATETIME>` — the timestamp BEFORE which rows
 *      are considered polluted (typically the merge commit of PR #251,
 *      `4102556a` = `2026-05-28T12:55:08Z`). The script REFUSES to start
 *      without it. A future cutoff is rejected too (exit 2) — it would
 *      either delete brand-new legitimate rows or be a typo.
 *
 *   2. DEFAULT BEHAVIOR is `--dry-run`. With no `--execute` flag the script
 *      counts the matching rows, prints the date range and a 5-row sample,
 *      and exits WITHOUT touching any data. This is the safe default
 *      because dropping a row from `agent_memories` is irreversible (the
 *      embedding was computed from `conteudo` text we may not retain
 *      elsewhere).
 *
 *   3. `--execute` is the explicit destructive flag. It prompts the
 *      operator for confirmation (`[y/N]`, default NO), then DELETEs the
 *      matching rows in batches inside a transaction. Any error mid-batch
 *      rolls back the in-flight batch and aborts.
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
 *   5. Every executed run appends ONE audit row to `admin_audit_log` with
 *      action='reflection_memory_cleanup', resource_type='agent_memories',
 *      and a change_summary JSON containing `cutoff`, `rows_deleted`,
 *      `executed_by_user`, `started_at`, `ended_at`. This is the operator-
 *      visible record of the cleanup — the spec says `audit_log` but
 *      `admin_audit_log` is the purpose-built APPEND-ONLY admin-mutation
 *      table (migration 047) and `audit_log.acao` is a typed enum that
 *      doesn't include a cleanup action; admin_audit_log.action is free-
 *      form text and the right home for this.
 *
 * USAGE:
 *
 *     # Find polluted rows (dry-run, the safe default)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --dry-run
 *
 *     # Execute deletion (with [y/N] confirmation prompt)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --execute
 *
 *     # Custom batch size (default 1000 per COMMIT)
 *     npx tsx scripts/reflection-memory-cleanup.ts \
 *       --cutoff=2026-05-28T12:55:08Z --execute --limit=500
 *
 *   The cutoff above is the merge time of PR #251 (commit 4102556a — the
 *   `reflection-batch` per-tenant context fix). Anything earlier was
 *   produced by the buggy worker; anything at or after the cutoff was
 *   produced by the fixed worker and is NOT in scope.
 *
 * EXIT CODES:
 *
 *     0  — success (counted in dry-run, or deleted in execute mode)
 *     2  — usage error: missing/invalid --cutoff, conflicting flags, or
 *          confirmation declined
 *     1  — unexpected error during execution (DB failure, etc.)
 */
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { createInterface } from 'node:readline';

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
        'usage: npx tsx scripts/reflection-memory-cleanup.ts --cutoff=<ISO_DATETIME> [--dry-run|--execute] [--limit=<N>]',
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
  cutoff: Date;
  cutoffRaw: string;
  execute: boolean;
  dryRun: boolean;
  limit: number;
};

/**
 * Parse and validate the CLI flags. Exported so the unit tests can drive the
 * rejection contract without spawning the script in a child process.
 *
 * Validation rules:
 *   - `--cutoff` is REQUIRED. Missing → `RequiredArgsError`.
 *   - `--cutoff` must parse as a valid date. Junk → `InvalidArgsError`.
 *   - `--cutoff` must NOT be in the future. A future cutoff would either
 *     delete brand-new legitimate rows or be a typo; either way it's a fail.
 *   - `--dry-run` and `--execute` are mutually exclusive. Passing both is
 *     ambiguous; fail loud.
 *   - When neither `--dry-run` nor `--execute` is present, default to
 *     dry-run (the safe option). This means a user who FORGETS `--execute`
 *     just gets a count — they don't accidentally wipe anything.
 *   - `--limit` must be a positive integer if present; defaults to
 *     `DEFAULT_BATCH_SIZE`.
 */
export function parseArgs(
  argv: string[],
  options?: { now?: () => Date },
): ParsedArgs {
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

  const execute = hasFlag(argv, 'execute');
  const dryRunFlag = hasFlag(argv, 'dry-run');
  if (execute && dryRunFlag) {
    throw new InvalidArgsError(
      'cannot pass both --execute and --dry-run; pick one (dry-run is the default)',
    );
  }
  // Default to dry-run when neither flag is present.
  const dryRun = !execute;

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

  return { cutoff, cutoffRaw, execute, dryRun, limit };
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'usage: npx tsx scripts/reflection-memory-cleanup.ts --cutoff=<ISO_DATETIME> [--dry-run|--execute] [--limit=<N>]',
  );
  console.error('');
  console.error('  --cutoff=<ISO>    REQUIRED. Rows with created_at < cutoff are in scope.');
  console.error('                    Recommended: PR #251 merge time (2026-05-28T12:55:08Z).');
  console.error('  --dry-run         DEFAULT. Count and sample, do NOT delete.');
  console.error('  --execute         Destructive. Prompts [y/N] then deletes.');
  console.error('  --limit=<N>       Batch size for DELETE loop. Default: ' + DEFAULT_BATCH_SIZE + '.');
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

export type DeleteResult = {
  rowsDeleted: number;
  batches: number;
  startedAt: string;
  endedAt: string;
};

/**
 * Run the batched DELETE for in-scope rows. Each batch:
 *   1. BEGIN
 *   2. DELETE ... WHERE id IN (SELECT id ... LIMIT batchSize)
 *      (re-evaluating the predicate inside the DELETE keeps it correct even
 *      if a row is concurrently inserted; the subselect re-filters by
 *      tenant/agent/cutoff/tipo.)
 *   3. COMMIT — on any error the transaction is rolled back and the loop
 *      aborts. We do NOT swallow errors and continue: a failed batch in the
 *      middle of a cleanup is a signal that something is wrong (lock,
 *      schema drift, etc.) and the operator should re-run from dry-run.
 *
 * The loop terminates when a batch returns zero deleted rows.
 *
 * Exported for tests so they can drive the production code path without
 * argv parsing or the readline prompt.
 */
export async function deleteInScope(args: {
  cutoff: Date;
  batchSize?: number;
  tipos?: readonly string[];
  log?: (msg: string) => void;
}): Promise<DeleteResult> {
  const tipos = args.tipos ?? VALID_REFLECTION_TIPOS;
  const cutoffIso = args.cutoff.toISOString();
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = args.log ?? (() => undefined);
  const startedAt = new Date().toISOString();

  let rowsDeleted = 0;
  let batches = 0;
  while (true) {
    let batchDeleted: number;
    let transactionStarted = false;
    try {
      await db.execute(sql`BEGIN`);
      transactionStarted = true;
      const deleteResult = await db.execute(sql`
        DELETE FROM agent_memories
        WHERE id IN (
          SELECT id FROM agent_memories
          WHERE tenant_id = ${POLLUTED_TENANT_ID}
            AND agent_id = ${POLLUTED_AGENT_ID}
            AND created_at < ${cutoffIso}::timestamptz
            AND tipo = ANY(${tipos as unknown as string[]})
          ORDER BY created_at
          LIMIT ${batchSize}
        )
      `);
      // `pg` driver exposes the number affected as `rowCount`. Cast through
      // unknown to avoid leaking the driver's full type signature.
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

    if (batchDeleted === 0) break;
    rowsDeleted += batchDeleted;
    batches++;
    log(`  batch ${batches}: deleted ${batchDeleted} (running total: ${rowsDeleted})`);
  }

  const endedAt = new Date().toISOString();
  return { rowsDeleted, batches, startedAt, endedAt };
}

/**
 * Append an `admin_audit_log` row recording the executed cleanup.
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
  cutoff: Date;
  rowsDeleted: number;
  executedByUser: string;
  startedAt: string;
  endedAt: string;
}): Promise<void> {
  const changeSummary = {
    cutoff: args.cutoff.toISOString(),
    rows_deleted: args.rowsDeleted,
    executed_by_user: args.executedByUser,
    started_at: args.startedAt,
    ended_at: args.endedAt,
    script: 'scripts/reflection-memory-cleanup.ts',
    issue: 260,
    pr_fix_reference: '4102556a (#251)',
  };
  await db.execute(sql`
    INSERT INTO admin_audit_log (tenant_id, actor_id, actor_role, action, resource_type, resource_id, change_summary)
    VALUES (
      ${'default'},
      ${args.executedByUser},
      ${'script'},
      ${'reflection_memory_cleanup'},
      ${'agent_memories'},
      ${null},
      ${JSON.stringify(changeSummary)}::jsonb
    )
  `);
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
 * Execute the destructive path: confirm, delete, audit, print.
 * Exported so tests can drive it with a stubbed confirmation reader.
 */
export async function runExecute(args: {
  cutoff: Date;
  batchSize?: number;
  executedByUser: string;
  confirmReader?: () => Promise<string>;
  log?: (msg: string) => void;
}): Promise<{ confirmed: boolean; result: DeleteResult | null }> {
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
    return { confirmed: true, result: { rowsDeleted: 0, batches: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } };
  }

  const confirmed = await confirmDestructive({
    prompt: 'Are you sure? [y/N] ',
    reader: args.confirmReader,
  });
  if (!confirmed) {
    log('Confirmation declined. No rows mutated.');
    return { confirmed: false, result: null };
  }

  const result = await runWithTenantContext(
    { tenant_id: POLLUTED_TENANT_ID, agent_id: POLLUTED_AGENT_ID },
    () => deleteInScope({ cutoff: args.cutoff, batchSize: args.batchSize, log }),
  );
  log(`deleted ${result.rowsDeleted} rows in ${result.batches} batch(es)`);

  // Audit row goes under tenant='system' ALS context (the cleanup action is
  // system-level), but the row's `tenant_id` column is set to 'default'
  // inside `appendAuditRow` because the dispatch spec says the audit row
  // belongs to the default bucket cleanup.
  await runWithTenantContext(
    { tenant_id: 'system', agent_id: 'system' },
    () =>
      appendAuditRow({
        cutoff: args.cutoff,
        rowsDeleted: result.rowsDeleted,
        executedByUser: args.executedByUser,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
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
  log('--- EXECUTE END ---');
  return { confirmed: true, result };
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

  if (parsed.dryRun) {
    await runDryRun({ cutoff: parsed.cutoff });
    process.exit(0);
  }

  // Resolve the operator identity for the audit row. `USER` (or
  // `USERNAME` on Windows) is the standard env-var; fall back to a stable
  // sentinel rather than 'unknown' so we never write an empty string.
  const executedByUser =
    process.env.USER ?? process.env.USERNAME ?? 'unknown-operator';

  const outcome = await runExecute({
    cutoff: parsed.cutoff,
    batchSize: parsed.limit,
    executedByUser,
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
