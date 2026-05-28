/**
 * Embeddings rebuild — admin tool that recomputes `agent_memories.embedding`
 * for rows missing it (or whose stored dimension differs from the configured
 * one, e.g. after switching providers).
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #239, project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * BEFORE this fix the script:
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
 * AFTER this fix:
 *   1. The script REQUIRES `--tenant=<id> --agent=<id>` CLI flags. Without
 *      them it refuses to start and exits with code 2 (usage error). This is
 *      an operator-driven admin tool — explicit > implicit, and a wrong run
 *      against the wrong tenant should fail loudly.
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
 *      routed tuple.
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

function arg(argv: string[], name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

/**
 * Parse and validate the required CLI flags. Exported so the unit test can
 * assert the rejection contract (missing --tenant or --agent → throws with a
 * stable `code`) without spawning the script in a child process.
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
        'usage: npm run embeddings:rebuild -- --tenant=<tenant_id> --agent=<agent_id>',
    );
    this.name = 'RequiredArgsError';
  }
}

export function parseRequiredArgs(argv: string[]): {
  tenant_id: string;
  agent_id: string;
} {
  const tenant_id = arg(argv, 'tenant');
  const agent_id = arg(argv, 'agent');
  const missing: string[] = [];
  if (!tenant_id) missing.push('--tenant');
  if (!agent_id) missing.push('--agent');
  if (missing.length > 0) throw new RequiredArgsError(missing);
  return { tenant_id: tenant_id as string, agent_id: agent_id as string };
}

function printUsage(extra?: string): void {
  if (extra) console.error(extra);
  console.error(
    'usage: npm run embeddings:rebuild -- --tenant=<tenant_id> --agent=<agent_id>',
  );
  console.error(
    '  Required: --tenant and --agent. The script processes exactly one',
  );
  console.error(
    '  (tenant_id, agent_id) tuple per run. This is intentional — see the',
  );
  console.error(
    '  module docstring for the cross-tenant isolation invariant (#239).',
  );
}

/**
 * Core rebuild loop for one (tenant, agent) tuple. Exported for unit tests so
 * they can drive the production code paths without re-implementing argv
 * parsing or `process.exit` handling. The CLI entrypoint `main()` below is the
 * only production invocation — everything inside this function runs under the
 * caller's `runWithTenantContext`.
 *
 * Returns `{ updated }` so callers (tests, future wrappers) can assert how many
 * rows were touched. The CLI entrypoint discards this and prints to stdout.
 */
export async function rebuildEmbeddingsForTuple(args: {
  tenant_id: string;
  agent_id: string;
  batchSize?: number;
  log?: (msg: string) => void;
}): Promise<{ updated: number; processed: number; totalInScope: number }> {
  const { tenant_id, agent_id } = args;
  const BATCH = args.batchSize ?? 32;
  const log = args.log ?? (() => undefined);

  const provider = getEmbeddingProvider();
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `provider_dim_mismatch: provider=${provider.dimensions} config=${config.EMBEDDING_DIMENSIONS}`,
    );
  }

  return runWithTenantContext({ tenant_id, agent_id }, async () => {
    const total = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM agent_memories
      WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
    `);
    const totalInScope = Number(
      (total.rows[0] as { count: string } | undefined)?.count ?? 0,
    );
    log(`agent_memories rows in scope: ${totalInScope}`);

    let processed = 0;
    let updated = 0;
    // Bound the loop independently of totalInScope — totalInScope counts ALL
    // rows in scope, while the SELECT only fetches rows whose embedding is
    // null or has the wrong dimension. We iterate until SELECT returns an
    // empty page.
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
      const embs = await provider.embed(texts);
      for (let i = 0; i < rows.rows.length; i++) {
        const r = rows.rows[i] as { id: string };
        const v = `[${(embs[i] ?? []).join(',')}]`;
        // UPDATE pins tenant_id AND agent_id alongside the id — a stale or
        // mistyped id cannot mutate a row outside the routed tuple.
        await db.execute(sql`
          UPDATE agent_memories
          SET embedding = ${v}::vector
          WHERE id = ${r.id}::uuid
            AND tenant_id = ${tenant_id}
            AND agent_id = ${agent_id}
        `);
        updated++;
      }
      processed += rows.rows.length;
      log(`  processed ${processed} (updated ${updated}, total in scope ${totalInScope})`);
    }
    return { updated, processed, totalInScope };
  });
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

  const provider = getEmbeddingProvider();
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    console.error(
      `provider dim ${provider.dimensions} != config ${config.EMBEDDING_DIMENSIONS}`,
    );
    process.exit(1);
  }
  console.log(
    `rebuilding embeddings with ${provider.name}/${provider.modelId} (${provider.dimensions}d)`,
  );
  console.log(`scope: tenant_id=${tenant_id} agent_id=${agent_id}`);

  const { updated } = await rebuildEmbeddingsForTuple({
    tenant_id,
    agent_id,
    log: (m) => console.log(m),
  });
  console.log(`done: ${updated} rows updated for tenant_id=${tenant_id} agent_id=${agent_id}`);
  process.exit(0);
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
