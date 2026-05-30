import { tickEngine } from '@/workflows/engine.js';
import { workflowsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Issue #345 (Phase 4 of #323), Batch D — per-tenant fan-out for the
 * `workflow_engine_tick` job (the final production worker migrated off the
 * `default/default` sentinel).
 *
 * BEFORE: the job body was registered INLINE in `src/workers/index.ts` and ran
 * the workflow engine under a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () => tickEngine())`.
 * `tickEngine()` reads/writes `workflows` + `workflow_steps` (both tenant-aware
 * tables whose repos read the ALS tenant/agent), so under a multi-tenant
 * deployment ONLY the `default` agent's workflows were ever ticked — every real
 * tenant's pending dual-approval workflows silently never advanced or expired.
 * Once `MAIA_REJECT_DEFAULT_LITERAL` flips on, the literal `default` context is
 * rejected and the inline job would throw on the first ALS read.
 *
 * AFTER: this module is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that own at least one workflow in
 * a status `tickEngine()` processes
 * (`workflowsRepo.listTenantAgentPairsWithActiveWorkflows`, whose status filter
 * mirrors `workflowsRepo.listPending()` — the engine's own "which workflows are
 * due" predicate — so there is no UNDER-enumeration), then runs `tickEngine()`
 * ONCE PER tuple under `runWithTenantContext`. `tickEngine()` is unchanged: each
 * per-tuple run reads/mutates ONLY the running tuple's workflow + step rows (its
 * repos bind tenant_id + agent_id from the ALS the dispatcher establishes), so a
 * tick for tuple A can NEVER advance or cancel tenant B's workflow — the
 * inviolable cross-tenant isolation invariant. (A leak here would let one
 * tenant's engine mutate another tenant's workflow rows — a severe breach.)
 *
 * Behavior-preserving in single-tenant mode: when the only workflows live under
 * `('default','default')`, the enumeration yields exactly that one tuple, so the
 * engine still ticks once under default. Fail-isolated per tuple (mirrors the
 * merged Batches A #350 / B #351 / C #352): a throw under one tuple must not
 * abort the tick for the others.
 */
export async function runWorkflowEngineTick(): Promise<void> {
  // Enumerate OUTSIDE any tenant context — this read partitions the work table
  // by its own (tenant_id, agent_id) columns and must NOT inherit an ambient
  // scope. The dispatcher opens a per-tuple context below.
  const tuples = await workflowsRepo.listTenantAgentPairsWithActiveWorkflows();

  if (tuples.length === 0) {
    logger.debug('workflow_engine_tick.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, async () => {
        await tickEngine();
      });
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a throw under one tuple must not
      // abort the engine tick for the others.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'workflow_engine_tick.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'workflow_engine_tick.done',
  );
}
