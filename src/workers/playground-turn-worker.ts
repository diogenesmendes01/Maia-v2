/**
 * Playground turn worker (issue #464).
 *
 * Postgres-as-queue consumer for the admin-console sandbox chat: the admin-ui
 * (Postgres-only process) inserts `playground_turns` rows with
 * status='queued'; this worker claims them (FOR UPDATE SKIP LOCKED via
 * `playgroundRepo.claimNextQueuedTurn`), runs the sandboxed turn
 * (`runPlaygroundTurn` — no outbox, no memory, no learning, tools unbound)
 * and writes the agent reply back.
 *
 * Latency: the cron tick is 1/min, but each invocation DRAINS the queue in a
 * loop for up to ~50s, polling every 2s when idle — effective chat latency is
 * a couple of seconds (same drain-inside-tick pattern as outbox_drain). A
 * module-level guard prevents overlapping invocations from stacking; the
 * SKIP LOCKED claim makes overlap harmless anyway.
 *
 * Each claimed turn runs under `runWithTenantContext` derived FROM THE ROW —
 * the worker is cross-tenant only at claim time, never while executing.
 */
import { logger } from '@/lib/logger.js';
import { playgroundRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runPlaygroundTurn } from '@/agent/playground-turn.js';

const DRAIN_BUDGET_MS = 50_000;
const IDLE_POLL_MS = 2_000;

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runPlaygroundTurnWorker(): Promise<void> {
  if (running) return; // previous tick still draining — skip, don't stack
  running = true;
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  try {
    // Cheap TTL sweep once per tick — expired sessions cascade their turns.
    const swept = await playgroundRepo.deleteExpiredSessions();
    if (swept > 0) {
      logger.info({ swept }, 'playground.sessions_swept');
    }

    while (Date.now() < deadline) {
      const claimed = await playgroundRepo.claimNextQueuedTurn();
      if (!claimed) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const { turn, session } = claimed;
      try {
        const result = await runWithTenantContext(
          { tenant_id: turn.tenant_id, agent_id: turn.agent_id },
          async () => runPlaygroundTurn({ session, turn }),
        );
        if (result.ok) {
          await playgroundRepo.completeTurn({
            user_turn_id: turn.id,
            session_id: session.id,
            tenant_id: turn.tenant_id,
            agent_id: turn.agent_id,
            reply: result.reply,
            decision_meta: result.decision_meta,
          });
        } else {
          await playgroundRepo.failTurn({
            user_turn_id: turn.id,
            error_detail: `${result.reason}: ${result.detail}`,
          });
        }
      } catch (e) {
        // Never leave a turn stuck in 'running' — the operator is watching.
        await playgroundRepo.failTurn({
          user_turn_id: turn.id,
          error_detail: e instanceof Error ? e.message : String(e),
        });
        logger.error(
          { err: e, turn_id: turn.id, tenant_id: turn.tenant_id, agent_id: turn.agent_id },
          'playground.turn_failed',
        );
      }
    }
  } finally {
    running = false;
  }
}
