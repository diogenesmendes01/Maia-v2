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
 *   - [MEDIUM] Concurrency guard: `pg_try_advisory_lock(hash, hash2)` (session-
 *     scoped, NOT `_xact_lock` — see review v2) keyed by ('embeddings-rebuild',
 *     tenant_id, agent_id) on a dedicated pool client. Two simultaneous runs
 *     on the same tuple → the second fails fast with exit code 75 (EX_TEMPFAIL)
 *     instead of double-paying the provider. The lock is explicitly released
 *     via `pg_advisory_unlock` in `finally` on the SAME client (pinned via
 *     `pool.connect()`) so it cannot leak across runs.
 *
 *     Why session-level + dedicated client (not `_xact_lock` + autocommit):
 *     `pg_try_advisory_xact_lock` is released at the END of the holding
 *     transaction; under drizzle's `db.execute` autocommit each statement is
 *     its own transaction, so the lock would release the instant the acquiring
 *     SELECT returns — two concurrent runs could BOTH "acquire" the lock and
 *     race the rest of the rebuild. Session-level `pg_try_advisory_lock` on a
 *     pinned `pool.connect()` client survives across statements until the
 *     explicit `pg_advisory_unlock` in `finally`.
 *   - [LOW] `--dry-run` mode: counts in-scope and pending rows without calling
 *     the provider and without issuing UPDATEs.
 *   - [LOW] TTY confirmation: prompts the operator before any mutation unless
 *     `--yes` is passed (CI/cron path) or stdin is not a TTY in which case
 *     `--yes` is required (refuses to mutate without explicit confirmation).
 *   - [LOW] Post-write verification: each UPDATE returns the id; if the row
 *     count is not exactly 1 we log a `update_no_op` warning with full tuple
 *     context rather than incrementing the success counter blindly.
 *   - [HIGH][#244 review] Per-batch transaction: all UPDATEs in one batch run
 *     inside a single `db.transaction()`. A mid-batch DB failure rolls back
 *     the entire batch — the caller no longer sees "rows 1..N-1 committed,
 *     row N failed, batch advertised as failed" inconsistency. Previously the
 *     loop did per-row autocommit, so a poison row at index N left the prior
 *     N-1 rows committed under a failed return. Trade-off: the txn holds for
 *     N UPDATEs (milliseconds at default BATCH=32) — the session-level
 *     advisory lock acquired ABOVE on a separate client is orthogonal and
 *     still released in `finally`. Race-detection (RETURNING id = 0 rows)
 *     still logs warn but does NOT throw, so transient worker tenant-flips
 *     don't roll back the whole batch.
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
import { pathToFileURL } from 'node:url';
import { db, pool } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { getEmbeddingProvider, type EmbeddingProvider } from '@/lib/embeddings.js';
import { config } from '@/config/env.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';

/**
 * Thrown when the embedding provider returns a different number of vectors
 * than texts requested (issue #289). This is a hard contract violation:
 * aligning by index with `embs[i]` becomes meaningless, so the only safe
 * action is to abort the batch and surface it to the operator. The
 * pre-existing re-detection predicate
 * (`embedding IS NULL OR vector_dims(...) != EXPECTED_DIM`) keeps the rows
 * pending for the next run, so no progress is lost — and pgvector never
 * sees a misaligned or `[]::vector` write.
 */
export class ProviderCardinalityError extends Error {
  constructor(expected: number, got: number) {
    super(`embedding_provider_cardinality_mismatch: expected ${expected}, got ${got}`);
    this.name = 'ProviderCardinalityError';
  }
}

/**
 * Row shape consumed by `rebuildBatch`. Within a single
 * `rebuildEmbeddingsForTuple` invocation all rows share the same
 * (tenant_id, agent_id) tuple — the SELECT pins both predicates — but we
 * carry them per row so audit events for skipped rows attribute under the
 * row's own context (matches the #289 contract of "audit lands in the right
 * tenant's audit log").
 */
export interface MemoryRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
}

export interface RebuildBatchResult {
  updated: number;
  skipped: number;
}

/**
 * Rebuilds embeddings for a single batch of rows (issue #289). Validates
 * provider cardinality BEFORE the loop and validates per-vector dimension
 * BEFORE each UPDATE. Invalid rows are skipped (audited under their own
 * tenant context via `runWithTenantContext`) so the batch can make partial
 * progress and survivors get picked up by the next run's re-detection
 * predicate (`embedding IS NULL OR vector_dims(...) != EXPECTED_DIM`).
 *
 * Previously the per-row update used `embs[i] ?? []`, which silently wrote
 * `[]::vector`. pgvector treats `[]` as a zero-vector, so semantic search
 * returned similarity 0 for those rows until the next run's re-detection
 * caught the wrong dimension — a corruption window invisible to ops.
 *
 * UPDATE pins (id, tenant_id, agent_id) so the write cannot land outside
 * the routed tuple even with a stale id. Uses `tx.execute` so it composes
 * cleanly with the per-batch transaction in
 * `rebuildEmbeddingsForTuple`. `RETURNING id` lets the caller verify the
 * row really matched (race detection — see the no-op warn path).
 *
 * Exported so unit tests can drive cardinality / dim cases without paying
 * the cost of the full CLI + advisory-lock + transaction harness.
 */
export async function rebuildBatch(
  provider: EmbeddingProvider,
  rows: MemoryRow[],
  expectedDim: number,
  exec: (s: ReturnType<typeof sql>) => Promise<{ rows: Array<{ id: string }> }> = (
    s,
  ) => db.execute<{ id: string }>(s) as Promise<{ rows: Array<{ id: string }> }>,
): Promise<RebuildBatchResult> {
  if (rows.length === 0) return { updated: 0, skipped: 0 };

  const texts = rows.map((r) => r.conteudo);
  const embs = await provider.embed(texts);

  // Cardinality check FIRST — if the provider returned a different number
  // of vectors than texts, every index from here on is unreliable. Abort
  // the batch so we never write a misaligned vector. The outer caller will
  // surface this to the operator; pending rows remain pending.
  if (embs.length !== texts.length) {
    throw new ProviderCardinalityError(texts.length, embs.length);
  }

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const vec = embs[i];

    // Per-item dim check — defensive. The upstream DimensionGuard already
    // throws on dim mismatch, but if it's ever bypassed (e.g. a future
    // provider that skips the guard, or a mocked provider in tests), this
    // catches the regression before we write `[]::vector` or a wrong-dim
    // vector that pgvector would silently accept as zero-similarity.
    if (!vec || !Array.isArray(vec) || vec.length !== expectedDim) {
      skipped++;
      logger.warn(
        {
          tenant_id: row.tenant_id,
          agent_id: row.agent_id,
          memory_id: row.id,
          expected_dim: expectedDim,
          got_dim: vec?.length ?? 0,
          op: 'embeddings_rebuild_skip_invalid',
        },
        'embeddings-rebuild: skipping row with invalid vector (missing or wrong dim)',
      );
      // Audit under the row's tenant context so the event is attributed
      // correctly. The outer caller is already running inside
      // runWithTenantContext, but we re-enter explicitly here to match
      // the #289 contract — and to keep this function correct if a future
      // caller invokes it outside a tenant scope.
      await runWithTenantContext(
        { tenant_id: row.tenant_id, agent_id: row.agent_id },
        () =>
          audit({
            acao: 'embeddings_rebuild_skip_invalid',
            entidade_alvo: 'agent_memory',
            alvo_id: row.id,
            metadata: {
              expected_dim: expectedDim,
              got_dim: vec?.length ?? 0,
              reason: !vec ? 'missing_vector' : 'wrong_dimension',
            },
          }),
      );
      continue;
    }

    const literal = `[${vec.join(',')}]`;
    // UPDATE pins (id, tenant_id, agent_id) — defense in depth against a
    // stale id or wrong ALS context. RETURNING id lets the per-batch
    // transaction's no-op detection (race with worker tenant flip) fire
    // exactly as before.
    const result = await exec(sql`
      UPDATE agent_memories
      SET embedding = ${literal}::vector
      WHERE id = ${row.id}::uuid
        AND tenant_id = ${row.tenant_id}
        AND agent_id = ${row.agent_id}
      RETURNING id::text
    `);
    if (result.rows.length === 1) {
      updated++;
    } else {
      // Race detection — the caller's per-batch txn loop logs this as a
      // warn but does NOT throw, so transient worker tenant-flips don't
      // roll back the whole batch. We surface the no-op via skipped count
      // here so the caller's batch counters stay consistent with the
      // returning {updated, skipped} contract; the warn is logged by the
      // caller against the row id when it sees batchNoOps populated.
      skipped++;
      logger.warn(
        {
          tenant_id: row.tenant_id,
          agent_id: row.agent_id,
          row_id: row.id,
          affected: result.rows.length,
          op: 'embeddings_rebuild_update_no_op',
        },
        'embeddings-rebuild: UPDATE matched zero rows (race with worker?)',
      );
    }
  }

  return { updated, skipped };
}

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
 * `pg_try_advisory_lock(int4, int4)` / `pg_advisory_unlock(int4, int4)`. Two
 * args (instead of one int8) lets us combine ('embeddings-rebuild', tenant,
 * agent) deterministically.
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
 * Locking: the function acquires session-level `pg_try_advisory_lock` keyed
 * by (fnv1a32('embeddings-rebuild'), fnv1a32(`${tenant_id}::${agent_id}`)) on
 * a dedicated pool client (pinned via `pool.connect()`). If another process
 * holds the lock for the same tuple, the function throws `ConcurrentRunError`
 * (mapped to exit 75 by the CLI). The lock is explicitly released via
 * `pg_advisory_unlock` in `finally` on the same pinned client — survives
 * statement boundaries and cannot leak past the run.
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
  skipped: number;
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
    // ─── Concurrency guard (review v2 fix) ───────────────────────────────
    // We use SESSION-level `pg_try_advisory_lock` (NOT `_xact_lock`) on a
    // dedicated pool client. Rationale:
    //   - `pg_try_advisory_xact_lock` is released at the END of the holding
    //     transaction. Drizzle's `db.execute` runs each statement in its own
    //     autocommit transaction, so the lock would release the instant the
    //     acquiring SELECT returns — two concurrent runs could BOTH "acquire"
    //     and race the rest of the work.
    //   - Session-level `pg_try_advisory_lock` persists across statements
    //     until either an explicit `pg_advisory_unlock` or the session ends.
    //     Pinning lock+unlock to a single `pool.connect()` client guarantees
    //     both calls hit the same session so the unlock actually releases.
    //   - try_* (non-blocking): a concurrent runner should fail fast and
    //     surface to the operator rather than queue up.
    //
    // The SELECT/UPDATE inside the loop continue using `db.execute` (pool-
    // routed). They don't need the same session — the cluster-wide visibility
    // of the advisory lock blocks ANY concurrent acquire attempt regardless
    // of which connection it lands on.
    const lockClient = await pool.connect();
    let lockAcquired = false;
    try {
      const lockResult = await lockClient.query(
        'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
        [LOCK_NAMESPACE, LOCK_TUPLE_KEY],
      );
      // Production driver (node-postgres) returns `{ acquired: boolean }`.
      // Tests may surface either `acquired` or the bare function-name column.
      const lockRaw = (lockResult.rows[0] ?? {}) as Record<string, unknown>;
      lockAcquired =
        (lockRaw.acquired as boolean | undefined) ??
        (lockRaw.pg_try_advisory_lock as boolean | undefined) ??
        false;
      if (!lockAcquired) {
        logger.warn(
          { tenant_id, agent_id, op: 'embeddings_rebuild_lock_busy' },
          'embeddings-rebuild: advisory lock not acquired (concurrent run?)',
        );
        throw new ConcurrentRunError(tenant_id, agent_id);
      }

      // ─── Tuple body (read/update loop, unchanged behaviour) ──────────────
      // Continues under the cluster-wide protection of the session-level
      // advisory lock held by `lockClient` above. The lock is released in
      // `finally` below — see review v2 explanation at the top of this block.
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
        return {
          updated: 0,
          skipped: 0,
          processed: 0,
          totalInScope,
          pendingInScope,
          dryRun,
        };
      }

      let processed = 0;
      let updated = 0;
      // Bound the loop independently of pendingInScope — the SELECT only
      // fetches rows whose embedding is null or has the wrong dimension. We
      // iterate until SELECT returns an empty page.
      let skipped = 0;
      while (true) {
        // SELECT now pulls tenant_id + agent_id alongside id + conteudo so
        // the per-row audit in rebuildBatch can attribute under the row's
        // own context (#289). Within this loop these values are identical
        // to the outer scope (the WHERE pins them), but carrying them in
        // the row keeps rebuildBatch tenant-agnostic and matches the #289
        // contract.
        const rows = await db.execute<MemoryRow>(sql`
          SELECT id::text, tenant_id, agent_id, conteudo
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

        // ─── Per-batch transaction (Codex review #244, HIGH blocker) ────────
        // Wrap all UPDATEs in this batch in a single transaction so the batch
        // is atomic: either ALL N rows in the batch commit, or NONE do. The
        // previous per-row autocommit loop left rows 1..N-1 committed and rows
        // N..end un-touched when row N's UPDATE failed mid-batch — the caller
        // saw an error but partial state was already persisted.
        //
        // Trade-offs documented for ops:
        //   - The transaction holds for the duration of N UPDATEs. With the
        //     default BATCH=32 and pg row locks, this is fast (milliseconds);
        //     larger batches mean longer hold time.
        //   - The session-level advisory lock acquired above (on a SEPARATE
        //     pinned client) is ORTHOGONAL to this txn — it survives across
        //     batches and is released in `finally` below. The txn here only
        //     governs the atomicity of the UPDATEs in ONE batch.
        //   - On failure, we throw and the outer caller surfaces the error;
        //     the lock is released in `finally` and `processed`/`updated` are
        //     NOT incremented for the rolled-back batch (counter integrity).
        //
        // Issue #289 (cardinality + dim validation): the provider call moves
        // INSIDE the txn body via rebuildBatch. ProviderCardinalityError
        // thrown by rebuildBatch rolls the batch back (no UPDATEs commit) —
        // exactly the safety contract #289 needs, since a misaligned-index
        // failure makes ALL embs[i] writes suspect. The per-item dim check
        // inside rebuildBatch logs warn + audits + continues; survivors are
        // captured by the next run's re-detection predicate.
        //
        // The race-detection / "UPDATE matched zero rows" path (mid-batch
        // worker tenant flip) still logs a warn but does NOT throw — it
        // shows up in rebuildBatch's `skipped` count rather than as a
        // committed update. Only an exception from `tx.execute` (DB-level
        // failure) or rebuildBatch (cardinality, provider) rolls back the
        // batch.
        let batchResult: { updated: number; skipped: number } = {
          updated: 0,
          skipped: 0,
        };
        const batchRows = rows.rows.map((r) => r as MemoryRow);
        try {
          await db.transaction(async (tx) => {
            // Reset per-batch counters inside the txn so a retry of this
            // closure (drizzle/pg can retry on serialization failures) starts
            // from zero.
            batchResult = await rebuildBatch(
              provider,
              batchRows,
              config.EMBEDDING_DIMENSIONS,
              (s) =>
                tx.execute<{ id: string }>(s) as Promise<{
                  rows: Array<{ id: string }>;
                }>,
            );
          });
        } catch (err) {
          // The whole batch rolled back — none of the N UPDATEs committed.
          // Counters are NOT incremented (batchResult is reset below).
          batchResult = { updated: 0, skipped: 0 };
          if (err instanceof ProviderCardinalityError) {
            logger.error(
              {
                tenant_id,
                agent_id,
                batch_size: batchRows.length,
                op: 'embeddings_rebuild_cardinality_mismatch',
                err,
              },
              'embeddings-rebuild: provider cardinality mismatch — batch rolled back, no UPDATEs committed',
            );
          } else {
            logger.error(
              {
                tenant_id,
                agent_id,
                batch_size: batchRows.length,
                op: 'embeddings_rebuild_batch_failed',
                err,
              },
              'embeddings-rebuild: batch failed — transaction rolled back, no UPDATEs committed for this batch',
            );
          }
          throw err;
        }

        updated += batchResult.updated;
        skipped += batchResult.skipped;
        processed += rows.rows.length;
        log(
          `  processed ${processed} (updated ${updated}, skipped ${skipped}, total in scope ${totalInScope})`,
        );
      }
      return { updated, skipped, processed, totalInScope, pendingInScope, dryRun };
    } finally {
      // Release the lock on the SAME client / session that acquired it.
      // Skip if acquire failed (nothing to unlock). Swallow errors here so a
      // unlock failure doesn't mask a more interesting upstream error — the
      // worst case (lock leak on this connection) self-heals when the pool
      // closes the connection on its idle-timeout.
      if (lockAcquired) {
        try {
          await lockClient.query(
            'SELECT pg_advisory_unlock($1::int4, $2::int4)',
            [LOCK_NAMESPACE, LOCK_TUPLE_KEY],
          );
        } catch (err) {
          logger.warn(
            { tenant_id, agent_id, err, op: 'embeddings_rebuild_unlock_failed' },
            'embeddings-rebuild: pg_advisory_unlock failed (non-fatal — pool idle-timeout will release)',
          );
        }
      }
      lockClient.release();
    }
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
        skipped: result.skipped,
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
        skipped: result.skipped,
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
        `done: ${result.updated} rows updated, ${result.skipped} skipped for tenant_id=${tenant_id} agent_id=${agent_id}`,
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
// compare against argv[1] (a filesystem PATH) by normalising it through
// Node's `pathToFileURL` (`node:url`). This is the only correct way to
// build a `file://` URL on Windows.
//
// Why the previous hand-rolled `new URL(\`file://${entry.replace(/\\/g, '/')}\`)`
// failed on Windows (Codex review #244, HIGH blocker):
//   - On Windows, `process.argv[1]` is a path like `C:\path\to\script.ts`.
//   - Replacing backslashes yields `C:/path/to/script.ts`.
//   - `new URL(\`file://${...}\`)` then produces `file://C:/path/to/script.ts`
//     (host = `c:` — wrong) instead of `file:///C:/path/to/script.ts` (host
//     empty, path absolute — correct, and what `import.meta.url` resolves to).
//   - Result: the comparison is ALWAYS false on Windows, so `main()` is never
//     invoked when running `npm run embeddings:rebuild` — the script loads
//     and exits silently.
//
// `pathToFileURL` is OS-aware: on Windows it emits the proper
// `file:///C:/...` (three slashes, drive letter), on POSIX it emits
// `file:///abs/path`. Matches `import.meta.url` exactly on both platforms.
//
// We still wrap in try/catch (e.g. argv[1] could be undefined in unusual
// invocations) and keep the `EMBEDDINGS_REBUILD_NO_MAIN` escape hatch so
// tests / wrappers can override if needed.
export function isDirectInvocation(
  entry: string | undefined,
  metaUrl: string,
): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

const invokedDirectly = isDirectInvocation(process.argv[1], import.meta.url);

if (invokedDirectly && !process.env.EMBEDDINGS_REBUILD_NO_MAIN) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
