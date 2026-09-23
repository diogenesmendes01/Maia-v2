import {
  engineRunsRepo,
  type DueScopeCursor,
  type DueRunCursor,
} from '@/db/repositories/engine-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { closeSyntheticHermesHandoff } from '@/runtime/engines/recover-synthetic-output.js';
import { enqueueAgentForRecovery } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';

/** G03 bounded durable sweep. PostgreSQL next_poll_at is the maintenance queue:
 * losing this process or Redis never removes the debt. No second turn executor,
 * heartbeat, engine start, tool dispatcher or sender lives here.
 * Production remote observation/cancel remains unavailable, so ambiguous runs
 * are quarantined, NOT retried as a new generation. */
export function createEngineRecoveryRunner() {
  let cursor: DueScopeCursor | null = null;
  let pending: Array<{ tenant_id: string; agent_id: string }> = [];
  let runCursor: DueRunCursor | null = null;
  let dueBefore: string | undefined;
  // Continuations are only scheduling hints. Restart may revisit work; all
  // authority and debt remain in PostgreSQL. Memory is one bounded scope page.
  return async function runEngineRecovery(
    options: { scopeLimit?: number; runLimit?: number; maxPages?: number } = {},
  ): Promise<void> {
    let transportFailed = false;
    for (let page = 0; page < (options.maxPages ?? 10); page++) {
      if (!pending.length) {
        const scopes = await engineRunsRepo.enumerateDueScopes({
          limit: options.scopeLimit ?? 20,
          cursor,
        });
        pending = scopes.scopes;
        cursor = scopes.next_cursor;
        if (!pending.length) break;
      }
      // One run page per work unit, at most scopeLimit work units per batch.
      for (let unit = 0; unit < (options.scopeLimit ?? 20) && pending.length; unit++) {
        const scope = pending[0]!;
        dueBefore ??= new Date().toISOString();
        await runWithTenantContext(scope, async () => {
          const { runs, next_cursor } = await engineRunsRepo.listDueRuns({
            limit: options.runLimit ?? 20,
            cursor: runCursor,
            dueBefore,
          });
          for (const run of runs) {
            try {
              // Correlated DB-only close uses its own CAS, not the poll reservation.
              // It also works for terminal/outbound_pending turns, without a claim.
              await closeSyntheticHermesHandoff(run.turn_id);
              const reservation = await engineRunsRepo.reserveMaintenanceObservation({
                run_id: run.run_id,
                window_ms: 60_000,
                actor: { kind: 'recovery', actor_ref: 'engine_recovery' },
              });
              if (!reservation.ok) continue;
              const result = await engineRunsRepo.reconcileReservedRun({
                run_id: run.run_id,
                reserved_row_version: reservation.reserved_row_version,
              });
              if (result.kind === 'enqueue') {
                // Same deterministic BullMQ job and normal claim as inbound/recovery.
                if (!transportFailed) {
                  try {
                    await enqueueAgentForRecovery({
                      turn_id: result.turn_id,
                      mensagem_id: result.mensagem_id,
                    });
                  } catch (err) {
                    // One failed network deadline per tick, not per run. Still
                    // visit every DB-only candidate within the traversal budget.
                    transportFailed = true;
                    throw err;
                  }
                }
              } else if (result.kind === 'blocked') {
                logger.warn(
                  { ...scope, run_id: run.run_id, ops_alert: true },
                  'engine_recovery.operator_required',
                );
              }
            } catch (err) {
              // Reservation/debt remains durable and due again after its finite
              // window. Never acknowledge a failed CAS as completed maintenance.
              logger.error({ ...scope, run_id: run.run_id, err }, 'engine_recovery.failed');
            }
          }
          runCursor = next_cursor;
          if (!runCursor) {
            pending.shift();
            dueBefore = undefined;
          }
        });
      }
      if (!pending.length && !cursor) break;
    }
  };
}

export const runEngineRecovery = createEngineRecoveryRunner();
