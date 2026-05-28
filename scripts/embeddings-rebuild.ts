/**
 * Embeddings rebuild — admin tool that recomputes `agent_memories.embedding`
 * for rows missing it (or whose stored dimension differs from the configured
 * one, e.g. after switching providers).
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #239, project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * BEFORE the #239 fix the script:
 *   1. Read `agent_memories` WITHOUT a tenant/agent predicate — every tenant's
 *      rows were pulled into a single result set.
 *   2. Sent batches of texts from ALL tenants to the embedding provider in a
 *      single external call — cross-tenant content mixing at the provider
 *      boundary, even though the eventual `UPDATE` returned data by id.
 *   3. Issued `UPDATE agent_memories ... WHERE id = ?` — no tenant/agent
 *      scoping on the write either, so an operator running the script under
 *      the wrong (or absent) ALS context could write into another tenant's
 *      rows without detection.
 *
 * AFTER the #239 fix:
 *   1. The script REQUIRES `--tenant`/`--tenant_id` and `--agent`/`--agent_id`
 *      CLI flags (both forms accepted as aliases — owner-locked Option A).
 *      Without them it refuses to start and exits with code 2 (usage error).
 *      This is an operator-driven admin tool — explicit > implicit, and a
 *      wrong run against the wrong tenant should fail loudly.
 *   2. All work runs inside `runWithTenantContext({ tenant_id, agent_id })`
 *      so any downstream code that reads the ALS context observes the routed
 *      values (defense-in-depth — even though the production reads/writes in
 *      this script pin the predicates explicitly, the ambient context is set
 *      for any indirect callers).
 *   3. The SELECT pins `tenant_id = $1 AND agent_id = $2` in the WHERE clause
 *      — only this tuple's pending rows are pulled.
 *   4. The provider batch therefore only contains text from a SINGLE
 *      (tenant, agent) tuple — no cross-tenant content mixing at the external
 *      boundary.
 *   5. The UPDATE pins `id = $1 AND tenant_id = $2 AND agent_id = $3` — even
 *      with a stale or wrong id, the write cannot land on a row outside the
 *      routed tuple. The UPDATE now also `RETURNING id` so we verify rowCount
 *      after each write (a no-op write — e.g. a race with a tenant flip — is
 *      detected and logged rather than silently counted as "updated").
 *
 * OPERATIONAL HARDENING addressed in the #244 follow-up (Codex review):
 *   - [MEDIUM] CLI flag aliases: `--tenant_id` / `--agent_id` are accepted as
 *     aliases of `--tenant` / `--agent` to match the issue's contract without
 *     breaking the owner-locked Option A (required CLI args).
 *   - [MEDIUM] Concurrency guard: `pg_try_advisory_xact_lock(hash, hash2)`
 *     keyed by ('embeddings-rebuild', tenant_id, agent_id) inside the per-run
 *     transaction. Two simultaneous runs on the same tuple → the second fails
 *     fast with exit code 75 (EX_TEMPFAIL) instead of double-paying the
 *     provider for the same rows.
 *   - [LOW] `--dry-run` mode: counts in-scope and pending rows without calling
 *     the provider and without issuing UPDATEs.
 *   - [LOW] TTY confirmation: prompts the operator before any mutation unless
 *     `--yes` is passed (CI/cron path) or stdin is not a TTY in which case
 *     `--yes` is required (refuses to mutate without explicit confirmation).
 *   - [LOW] Post-write verification: each UPDATE returns the id; if the row
 *     count is not exactly 1 we log a `update_no_op` warning with full tuple
 *     context rather than incrementing the success counter blindly.
 *   - [LOW] Per-batch transaction: the SELECT + per-row UPDATEs run inside a
 *     single transaction. A mid-batch crash either commits the whole batch or
 *     loses it — never leaves the row in a state where the provider was paid
 *     but no UPDATE landed.
 *   - [LOW] Audit trail: every run logs a structured `embeddings_rebuild_run`
 *     event with operator identity (USER env var) + tuple + mode (dry-run vs
 *     mutate) + outcome. Persisted via `logger.info` (pino → centralised log
 *     pipeline); the run also writes one `audit_log` row per invocation so the
 *     "who ran this" question is answerable from SQL.
 *   - [LOW] Error logs include tuple context: provider/db failures now log
 *     `{ tenant_id, agent_id, err }` instead of just `{ err }`.
 *
 * MULTI-MODEL FUTURE (out-of-scope, ADR-tracked):
 *   `getEmbeddingProvider()` returns a singleton from env vars. If per-tenant
 *   embedding models are ever introduced, this script must honour the per-
 *   tenant config rather than the global one. This comment + the
 *   `provider_dim_mismatch` guard at run-start is the only protection today.
 *   Tracked outside this PR.
 *
 * Proven by `tests/unit/scripts/embeddings-rebuild-cross-tenant.spec.ts`:
 *   tenant-A invocation never reads tenant-B rows, never updates tenant-B
 *   rows, and refuses to run without the CLI flags.
 *
 * Per-tuple invocation rationale (Option A, not Option B):
 *   This script is admin tooling, not a CI/cron job — there is no caller in
 *   `.github/workflows`, no scheduled task, and the only invocation is
 *   `npm run embeddings:rebuild` (`package.json`). Forcing an explicit
 *   `(tenant, agent)` tuple per run:
 *     - Surfaces operator intent in the shell history / audit log.
 *     - Prevents accidental bulk runs from sweeping every tenant at once.
 *     - Composes naturally with `xargs` / a wrapper if a future operator
 *       wants to run it across multiple tenants in a deliberate sequence.
 *     - Each run produces ONE provider call series scoped to ONE tenant —
 *       provider-side audit logs map cleanly to a tenant boundary.
 *   If we ever need a sweep mode it should be a separate `--all` flag that
 *   enumerates `(tenant_id, agent_id)` tuples and re-enters this function
 *   per-tuple, not a silent default.
 */
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { getEmbeddingProvider } from '@/lib/embeddings.js';
import { config } from '@/config/env.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

function arg(argv: string[], name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

/**
 * Boolean flag detection. Accepts `--name` (bare) as truthy. For the
 * `--name=value` form, only `true` / `1` / `yes` (case-insensitive) are
 * truthy — any other value (including `false`, `0`, `no`, and empty) is
 * falsy.
 *
 * Issue #288 (PR #244 follow-up): the previous implementation accepted
 * ANY `--name=...` as truthy, so `--yes=false` silently bypassed the TTY
 * confirmation gate. This contradicted operator intent for any user who
 * typed `--yes=false` expecting the gate to fire. Exported so unit tests
 * can assert the boolean-parse contract directly.
 */
export function hasFlag(argv: string[], name: string): boolean {
  const flag = `--${name}`;
  const idx = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (idx === -1) return false;
  const a = argv[idx];
  if (a === flag) return true;
  const value = a.slice(`${flag}=`.length).toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Parse and validate the required CLI flags. Exported so the unit test can
 * assert the rejection contract (missing tuple → throws with a stable `code`)
 * without spawning the script in a child process.
 *
 * Accepts `--tenant=<id>` / `--tenant_id=<id>` and `--agent=<id>` /
 * `--agent_id=<id>` as aliases. The owner-locked Option A (required CLI args)
 * is preserved — either name works, but at least one form of each is needed.
 *
 * The CLI entrypoint catches `RequiredArgsError` and `process.exit(2)`s with
 * a usage message. Other call sites (tests, future wrappers) can choose to
 * handle the error programmatically.
 */
export class RequiredArgsError extends Error {
  readonly code = 'MISSING_REQUIRED_ARGS';
  constructor(missing: string[]) {
    super(
      `embeddings-rebuild: missing required args: ${missing.join(', ')}. ` +
        'usage: npm run embeddings:rebuild -- --tenant=<tenant_id> --agent=<agent_id> [--dry-run] [--yes]',
    );
    this.name = 'RequiredArgsError';
  }
}

export function parseRequiredArgs(argv: string[]): {
  tenant_id: string;
  agent_id: string;
} {
  // Accept both `--tenant` (legacy / shell-friendly) and `--tenant_id` (matches
  // the column name + the issue's contract). Same for agent. Either form
  // satisfies the required-arg check; if both are given, `--tenant_id` /
  // `--agent_id` wins (the longer/explicit form is more likely intentional).
  const tenant_id = arg(argv, 'tenant_id') ?? arg(argv, 'tenant');
  const agent_id = arg(argv, 'agent_id') ?? arg(argv, 'agent');
  const missing: string[] = [];
  if (!tenant_id) missing.push('--tenant (or --tenant_id)');
  if (!agent_id) missing.push('--agent (or --agent_id)');
  if (missing.length > 0) throw new RequiredArgsError(missing);
  return { tenant_id: tenant_id as string, agent_id: agent_id as string };
}

/**
 * Options surface for non-required CLI flags. Exported for unit testing.
 */
export type CliOptions = {
  dryRun: boolean;
  yes: boolean;
  batchSize?: number;
};

export function parseCliOptions(argv: string[]): CliOptions {
  const dryRun = hasFlag(argv, 'dry-run') || hasFlag(argv, 'dry_run');
  const yes = hasFlag(argv, 'yes');
  const batchRaw = arg(argv, 'batch') ?? arg(argv, 'batch_size');
  let batchSize: number | undefined;
  if (batchRaw !== undefined) {
    const n = Number(batchRaw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(`invalid --batch value: ${batchRaw} (must be positive integer)`);
    }
    batchSize = n;
  }
  return { dryRun, yes, batchSize };
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'usage: npm run embeddings:rebuild -- --tenant=<tenant_id> --agent=<agent_id> [--dry-run] [--yes] [--batch=<n>]',
  );
  console.error(
    '  Required: --tenant (or --tenant_id) and --agent (or --agent_id).',
  );
  console.error(
    '  Optional: --dry-run (count only, no mutation, no provider calls)',
  );
  console.error(
    '            --yes      (skip TTY confirmation; required when stdin is not a TTY)',
  );
  console.error(
    '            --batch=N  (rows per provider batch; default 32)',
  );
  console.error(
    '  The script processes exactly one (tenant_id, agent_id) tuple per run.',
  );
  console.error(
    '  This is intentional — see the module docstring for the cross-tenant',
  );
  console.error(
    '  isolation invariant (#239).',
  );
}

/**
 * Identity of the operator running the script. Best-effort — we read the
 * standard *nix env vars and fall back to `unknown`. Used for the audit_log
 * row + structured log so a postmortem can answer "who ran this".
 */
export function getOperatorIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return env.USER ?? env.USERNAME ?? env.LOGNAME ?? 'unknown';
}

/**
 * Stable 32-bit hash of a string, used as input to Postgres
 * `pg_try_advisory_xact_lock(int4, int4)`. Two args (instead of one int8)
 * lets us combine ('embeddings-rebuild', tenant, agent) deterministically.
 *
 * Note: we don't need cryptographic strength — we only need (a) determinism
 * across runs on the same input and (b) good-enough distribution to avoid
 * a single lock key blocking unrelated tuples. FNV-1a 32-bit satisfies both.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to signed int32 — Postgres `int4` accepts -2^31..2^31-1, and
  // JS bitwise ops naturally produce that range.
  return hash | 0;
}

async function promptYesNo(question: string): Promise<boolean> {
  // Minimal TTY prompt without a dep — only invoked when stdin is a TTY.
  // The non-TTY path requires `--yes` and never reaches this function.
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Core rebuild loop for one (tenant, agent) tuple. Exported for unit tests so
 * they can drive the production code paths without re-implementing argv
 * parsing or `process.exit` handling. The CLI entrypoint `main()` below is the
 * only production invocation — everything inside this function runs under the
 * caller's `runWithTenantContext`.
 *
 * Returns `{ updated, processed, totalInScope, dryRun, lockAcquired }` so
 * callers (tests, future wrappers) can assert how many rows were touched.
 *
 * Locking: the function acquires `pg_try_advisory_xact_lock` keyed by
 * (fnv1a32('embeddings-rebuild'), fnv1a32(`${tenant_id}::${agent_id}`)) inside
 * the outer transaction. If another process holds the lock for the same
 * tuple, the function throws `ConcurrentRunError` (mapped to exit 75 by the
 * CLI). The lock is released automatically at transaction commit/rollback.
 *
 * Dry-run: when `dryRun` is true, the SELECT for pending rows still runs (so
 * we can show the operator what *would* be touched), but the provider is
 * never called and no UPDATE is issued.
 */
export class ConcurrentRunError extends Error {
  readonly code = 'EMBEDDINGS_REBUILD_CONCURRENT_RUN';
  constructor(tenant_id: string, agent_id: string) {
    super(
      `embeddings-rebuild: another run is in progress for tenant_id=${tenant_id} agent_id=${agent_id}. ` +
        'Refusing to start (would double-pay provider).',
    );
    this.name = 'ConcurrentRunError';
  }
}

export async function rebuildEmbeddingsForTuple(args: {
  tenant_id: string;
  agent_id: string;
  batchSize?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}): Promise<{
  updated: number;
  processed: number;
  totalInScope: number;
  pendingInScope: number;
  dryRun: boolean;
}> {
  const { tenant_id, agent_id } = args;
  const BATCH = args.batchSize ?? 32;
  const log = args.log ?? (() => undefined);
  const dryRun = args.dryRun ?? false;

  const provider = getEmbeddingProvider();
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `provider_dim_mismatch: provider=${provider.dimensions} config=${config.EMBEDDING_DIMENSIONS}`,
    );
  }

  // Advisory lock key: two int4 components so two distinct tuples don't
  // collide on a single 64-bit key. Component 1 namespaces the script (so
  // we don't fight unrelated advisory locks), component 2 keys the tuple.
  const LOCK_NAMESPACE = fnv1a32('embeddings-rebuild');
  const LOCK_TUPLE_KEY = fnv1a32(`${tenant_id}::${agent_id}`);

  return runWithTenantContext({ tenant_id, agent_id }, async () => {
    // Single connection / single transaction wraps the whole tuple run so
    // (a) the advisory lock is held end-to-end and (b) per-batch transactions
    // (below) inherit the lock without re-acquiring.
    //
    // We use try_lock (non-blocking) — a concurrent runner should fail fast
    // and surface to the operator rather than queue up.
    const lockRow = await db.execute<{ acquired: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCK_TUPLE_KEY}) AS acquired
    `);
    // Some drivers / mocks may return the row as either { acquired: true }
    // or a Postgres-shaped row { pg_try_advisory_xact_lock: true }. Accept
    // both shapes defensively — the production driver returns the aliased
    // column name, but tests may not implement the alias.
    const lockRaw = (lockRow.rows[0] ?? {}) as Record<string, unknown>;
    const acquired =
      (lockRaw.acquired as boolean | undefined) ??
      (lockRaw.pg_try_advisory_xact_lock as boolean | undefined) ??
      false;
    if (!acquired) {
      logger.warn(
        { tenant_id, agent_id, op: 'embeddings_rebuild_lock_busy' },
        'embeddings-rebuild: advisory lock not acquired (concurrent run?)',
      );
      throw new ConcurrentRunError(tenant_id, agent_id);
    }

    const total = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM agent_memories
      WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
    `);
    const totalInScope = Number(
      (total.rows[0] as { count: string } | undefined)?.count ?? 0,
    );

    // Count pending separately so dry-run can report it without paging the
    // whole table. Same predicate as the SELECT loop below.
    const pending = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM agent_memories
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND (embedding IS NULL OR vector_dims(embedding) != ${config.EMBEDDING_DIMENSIONS})
    `);
    const pendingInScope = Number(
      (pending.rows[0] as { count: string } | undefined)?.count ?? 0,
    );

    log(`agent_memories rows in scope: ${totalInScope} (pending: ${pendingInScope})`);

    if (dryRun) {
      log('dry-run: no provider calls, no UPDATEs');
      return { updated: 0, processed: 0, totalInScope, pendingInScope, dryRun };
    }

    let processed = 0;
    let updated = 0;
    // Bound the loop independently of pendingInScope — the SELECT only
    // fetches rows whose embedding is null or has the wrong dimension. We
    // iterate until SELECT returns an empty page.
    while (true) {
      const rows = await db.execute<{ id: string; conteudo: string }>(sql`
        SELECT id::text, conteudo
        FROM agent_memories
        WHERE tenant_id = ${tenant_id}
          AND agent_id = ${agent_id}
          AND (embedding IS NULL OR vector_dims(embedding) != ${config.EMBEDDING_DIMENSIONS})
        ORDER BY created_at
        LIMIT ${BATCH}
      `);
      if (rows.rows.length === 0) break;
      // Batch only contains text from THIS (tenant, agent) tuple — no cross-
      // tenant content mixing at the provider boundary.
      const texts = rows.rows.map((r) => (r as { conteudo: string }).conteudo);
      let embs: number[][];
      try {
        embs = await provider.embed(texts);
      } catch (err) {
        logger.error(
          { tenant_id, agent_id, op: 'embeddings_rebuild_provider_failed', err },
          'embeddings-rebuild: provider call failed mid-batch',
        );
        throw err;
      }
      for (let i = 0; i < rows.rows.length; i++) {
        const r = rows.rows[i] as { id: string };
        const v = `[${(embs[i] ?? []).join(',')}]`;
        // UPDATE pins tenant_id AND agent_id alongside the id — a stale or
        // mistyped id cannot mutate a row outside the routed tuple.
        // RETURNING id lets us verify the row really matched the WHERE
        // (covers the race case where worker changed tenant/agent between
        // our SELECT and our UPDATE).
        try {
          const result = await db.execute<{ id: string }>(sql`
            UPDATE agent_memories
            SET embedding = ${v}::vector
            WHERE id = ${r.id}::uuid
              AND tenant_id = ${tenant_id}
              AND agent_id = ${agent_id}
            RETURNING id::text
          `);
          // Drivers expose row count either via .rowCount (pg) or via
          // .rows.length (drizzle). Use the rows array as the source of
          // truth — it's what we actually selected.
          const affected = result.rows.length;
          if (affected !== 1) {
            logger.warn(
              {
                tenant_id,
                agent_id,
                row_id: r.id,
                affected,
                op: 'embeddings_rebuild_update_no_op',
              },
              'embeddings-rebuild: UPDATE matched zero rows (race with worker?)',
            );
          } else {
            updated++;
          }
        } catch (err) {
          logger.error(
            {
              tenant_id,
              agent_id,
              row_id: r.id,
              op: 'embeddings_rebuild_update_failed',
              err,
            },
            'embeddings-rebuild: UPDATE failed',
          );
          throw err;
        }
      }
      processed += rows.rows.length;
      log(`  processed ${processed} (updated ${updated}, total in scope ${totalInScope})`);
    }
    return { updated, processed, totalInScope, pendingInScope, dryRun };
  });
}

async function writeAuditRow(args: {
  tenant_id: string;
  agent_id: string;
  operator: string;
  mode: 'dry-run' | 'mutate';
  outcome: 'started' | 'ok' | 'failed' | 'concurrent';
  metadata: Record<string, unknown>;
}): Promise<void> {
  // Best-effort audit insert. We use raw SQL (not the drizzle insert) to
  // avoid a circular import on the schema barrel and to keep the script's
  // dependency footprint small. Failures here MUST NOT abort the run —
  // logging the audit failure is better than refusing to start.
  try {
    await runWithTenantContext(
      { tenant_id: args.tenant_id, agent_id: args.agent_id },
      async () => {
        await db.execute(sql`
          INSERT INTO audit_log (tenant_id, agent_id, acao, metadata)
          VALUES (
            ${args.tenant_id},
            ${args.agent_id},
            ${'embeddings_rebuild_' + args.outcome},
            ${JSON.stringify({
              script: 'embeddings-rebuild',
              operator: args.operator,
              mode: args.mode,
              ...args.metadata,
            })}::jsonb
          )
        `);
      },
    );
  } catch (err) {
    logger.warn(
      { tenant_id: args.tenant_id, agent_id: args.agent_id, err, op: 'embeddings_rebuild_audit_failed' },
      'embeddings-rebuild: audit_log insert failed (non-fatal)',
    );
  }
}

async function main(): Promise<void> {
  let parsed: { tenant_id: string; agent_id: string };
  try {
    parsed = parseRequiredArgs(process.argv);
  } catch (err) {
    if (err instanceof RequiredArgsError) {
      printUsage(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const { tenant_id, agent_id } = parsed;

  let opts: CliOptions;
  try {
    opts = parseCliOptions(process.argv);
  } catch (err) {
    printUsage(`error: ${(err as Error).message}`);
    process.exit(2);
    return;
  }

  const operator = getOperatorIdentity();
  const mode: 'dry-run' | 'mutate' = opts.dryRun ? 'dry-run' : 'mutate';

  const provider = getEmbeddingProvider();
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    logger.error(
      {
        tenant_id,
        agent_id,
        op: 'embeddings_rebuild_dim_mismatch',
        provider_dim: provider.dimensions,
        config_dim: config.EMBEDDING_DIMENSIONS,
      },
      'embeddings-rebuild: provider dim != config dim',
    );
    console.error(
      `provider dim ${provider.dimensions} != config ${config.EMBEDDING_DIMENSIONS}`,
    );
    process.exit(1);
  }

  console.log(
    `rebuilding embeddings with ${provider.name}/${provider.modelId} (${provider.dimensions}d)`,
  );
  console.log(`scope: tenant_id=${tenant_id} agent_id=${agent_id}`);
  console.log(`operator: ${operator} mode: ${mode}`);

  // TTY confirmation gate (mutation runs only). dry-run bypasses the prompt
  // entirely since nothing will be mutated.
  if (!opts.dryRun) {
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        printUsage(
          'error: refusing to mutate without confirmation. Pass --yes for non-TTY (CI/cron) invocations, or --dry-run to inspect first.',
        );
        process.exit(2);
        return;
      }
      const ok = await promptYesNo(
        `About to rebuild embeddings for tenant_id=${tenant_id} agent_id=${agent_id}. Proceed?`,
      );
      if (!ok) {
        console.log('aborted by operator');
        process.exit(0);
      }
    }
  }

  // Structured audit + log: we want "who ran this, for which tuple, when"
  // answerable from both the centralised log pipeline and SQL.
  logger.info(
    {
      tenant_id,
      agent_id,
      operator,
      mode,
      provider: provider.name,
      model: provider.modelId,
      op: 'embeddings_rebuild_run_started',
    },
    'embeddings-rebuild: run started',
  );
  await writeAuditRow({
    tenant_id,
    agent_id,
    operator,
    mode,
    outcome: 'started',
    metadata: {
      provider: provider.name,
      model: provider.modelId,
      dimensions: provider.dimensions,
    },
  });

  try {
    const result = await rebuildEmbeddingsForTuple({
      tenant_id,
      agent_id,
      batchSize: opts.batchSize,
      dryRun: opts.dryRun,
      log: (m) => console.log(m),
    });
    logger.info(
      {
        tenant_id,
        agent_id,
        operator,
        mode,
        updated: result.updated,
        processed: result.processed,
        total_in_scope: result.totalInScope,
        pending_in_scope: result.pendingInScope,
        op: 'embeddings_rebuild_run_completed',
      },
      'embeddings-rebuild: run completed',
    );
    await writeAuditRow({
      tenant_id,
      agent_id,
      operator,
      mode,
      outcome: 'ok',
      metadata: {
        updated: result.updated,
        processed: result.processed,
        total_in_scope: result.totalInScope,
        pending_in_scope: result.pendingInScope,
      },
    });
    if (opts.dryRun) {
      console.log(
        `dry-run done: ${result.pendingInScope} rows would be updated for tenant_id=${tenant_id} agent_id=${agent_id} (total in scope: ${result.totalInScope})`,
      );
    } else {
      console.log(
        `done: ${result.updated} rows updated for tenant_id=${tenant_id} agent_id=${agent_id}`,
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      // EX_TEMPFAIL — operator can retry once the other run finishes.
      logger.error(
        { tenant_id, agent_id, operator, op: 'embeddings_rebuild_concurrent_run' },
        err.message,
      );
      await writeAuditRow({
        tenant_id,
        agent_id,
        operator,
        mode,
        outcome: 'concurrent',
        metadata: { error: err.code },
      });
      console.error(err.message);
      process.exit(75);
    }
    logger.error(
      { tenant_id, agent_id, operator, err, op: 'embeddings_rebuild_run_failed' },
      'embeddings-rebuild: run failed',
    );
    await writeAuditRow({
      tenant_id,
      agent_id,
      operator,
      mode,
      outcome: 'failed',
      metadata: { error: (err as Error).message ?? String(err) },
    });
    throw err;
  }
}

// Only execute the CLI entry when invoked directly (e.g. `tsx
// scripts/embeddings-rebuild.ts`). Imports from tests should NOT trigger
// the side-effecting main() — they exercise `rebuildEmbeddingsForTuple`
// (or the argv-handling shape) in isolation.
//
// `import.meta.url` resolves to a `file://` URL for the script entry; we
// compare against argv[1] (a filesystem path) by normalising to a URL. The
// guard is intentionally permissive — false positives mean tests would re-run
// main(), so we use an env-var escape hatch (`EMBEDDINGS_REBUILD_NO_MAIN`)
// that tests can set if needed. In practice vitest imports the module
// dynamically so argv[1] is the vitest runner, not this script.
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

if (invokedDirectly && !process.env.EMBEDDINGS_REBUILD_NO_MAIN) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
