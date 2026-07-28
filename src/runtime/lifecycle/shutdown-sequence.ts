/**
 * The ordered shutdown sequence and the signal handlers — issue #512 §5.
 *
 * Extracted out of `src/index.ts` so the ORDER can be asserted by a test
 * without importing the process entrypoint (which would execute `main()`).
 * The order is the contract, and review round 1 showed why: the original
 * sequence closed the WhatsApp sockets in step 3 and BullMQ only in step 4,
 * so an active job could reach an outbound send with the transport gone.
 *
 * Rule: stop accepting work → drain in-flight work → close consumers → close
 * the pools those consumers use. A dependency is never torn down before the
 * things that use it.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { shutdownPools } from '@/lib/healthcheck.js';
import { haltWorkerScheduling, drainWorkers } from '@/workers/index.js';
import { lifecycle } from './controller.js';

/**
 * Held here (not captured in a closure) so the sequence can be registered
 * BEFORE the server exists — a SIGTERM mid-boot must still drain.
 */
let httpApp: FastifyInstance | null = null;

export function setHttpApp(app: FastifyInstance | null): void {
  httpApp = app;
}

export function registerShutdownSequence(): void {
  // 1. STOP ACCEPTING WORK — atomic, no waiting, nothing closed yet.
  //    Review round 1 (P1): BullMQ used to stop consuming only in the FOURTH
  //    step, after the WhatsApp sockets had already closed — a job pulled
  //    meanwhile could reach an outbound send with the transport gone. Pausing
  //    here, before any drain, closes that hole; `deferIfNotAcceptingWork` in
  //    `src/gateway/queue.ts` covers the residual fetch-in-flight race by
  //    re-parking the job as delayed.
  lifecycle.registerShutdownStep({
    name: 'stop_accepting_work',
    timeoutMs: 5_000,
    run: async () => {
      const { pauseQueueWorkers } = await import('@/gateway/queue.js');
      await Promise.all([haltWorkerScheduling(), pauseQueueWorkers()]);
    },
  });

  // 2. crons: await the tick already running.
  lifecycle.registerShutdownStep({
    name: 'cron_workers',
    timeoutMs: config.SHUTDOWN_GRACE_MS,
    run: async () => {
      const { pending } = await drainWorkers(config.SHUTDOWN_GRACE_MS / 2);
      if (pending.length > 0) {
        throw new Error(`cron jobs still active: ${pending.join(', ')}`);
      }
    },
  });

  // 3. BullMQ: `worker.close()` waits for the ACTIVE job to finish. This runs
  //    BEFORE the WhatsApp sockets close so an in-flight turn can still send
  //    its reply. A job that outlives the deadline stays in Redis (BullMQ
  //    re-delivers it as stalled), so unfinished work remains recoverable.
  lifecycle.registerShutdownStep({
    name: 'bullmq',
    timeoutMs: config.SHUTDOWN_GRACE_MS,
    run: async () => {
      const { shutdownQueue } = await import('@/gateway/queue.js');
      await shutdownQueue();
      lifecycle.setComponent('agent_worker', 'stopped');
      lifecycle.setComponent('queue', 'stopped');
    },
  });

  // 4. tracked fire-and-forget work (post-turn reflection, line registration,
  //    reconnect timers). AFTER the queue and the crons, because those are
  //    what SPAWN these tasks — draining them earlier would just race.
  lifecycle.registerShutdownStep({
    name: 'background_tasks',
    run: async () => {
      const pending = await lifecycle.awaitBackgroundTasks(config.SHUTDOWN_GRACE_MS / 4);
      if (pending.length > 0) {
        throw new Error(`background tasks still active: ${pending.join(', ')}`);
      }
    },
  });

  // 5. additional WhatsApp lines, then the primary socket. Every producer of
  //    outbound traffic (jobs, crons, background tasks) is already quiet.
  //    Lines first so a per-line reconnect timer can never resurrect a socket
  //    after the primary session is gone (review #498 alto 3 cancels them).
  lifecycle.registerShutdownStep({
    name: 'line_sessions',
    run: async () => {
      const { shutdownLineSessions } = await import('@/gateway/line-sessions.js');
      await shutdownLineSessions();
    },
  });
  lifecycle.registerShutdownStep({
    name: 'baileys',
    run: async () => {
      const { shutdownBaileys } = await import('@/gateway/baileys.js');
      await shutdownBaileys();
      lifecycle.setComponent('whatsapp_session', 'stopped');
    },
  });

  // 6. HTTP. Fastify's `onClose` hooks stop the Redis memory collector and the
  //    DB probe timer, so this must run before the pools close.
  lifecycle.registerShutdownStep({
    name: 'http',
    run: async () => {
      if (!httpApp) return;
      await httpApp.close();
      lifecycle.setComponent('http', 'stopped');
    },
  });

  // 7. audit — still needs the DB pool, hence before `pools`.
  lifecycle.registerShutdownStep({
    name: 'audit_stop',
    critical: false,
    run: async () => {
      await audit({
        acao: 'system_stopped',
        metadata: { role: lifecycle.role, instance_id: lifecycle.instanceId },
      });
    },
  });

  // 8. pools LAST.
  lifecycle.registerShutdownStep({
    name: 'pools',
    run: async () => {
      await shutdownPools();
      lifecycle.setComponent('db', 'stopped');
      lifecycle.setComponent('redis', 'stopped');
    },
  });
}

export function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (lifecycle.isShuttingDown()) {
      // Second signal = the operator asked for a forced exit. It is metered,
      // logged and audited — a forced shutdown is never silent.
      lifecycle.recordForcedShutdown(`second_signal_${signal}`);
      void audit({
        acao: 'system_shutdown_forced',
        metadata: { signal, role: lifecycle.role, instance_id: lifecycle.instanceId },
      }).catch(() => undefined);
      // Small window so the audit row has a chance to land; then hard exit.
      setTimeout(() => process.exit(config.SHUTDOWN_FORCED_EXIT_CODE), 250);
      return;
    }
    void runShutdown(signal);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export async function runShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'maia.shutting_down');
  const outcome = await lifecycle.shutdown({ signal, reason: `signal:${signal}` });
  if (outcome.result === 'incomplete') {
    lifecycle.recordForcedShutdown('drain_deadline');
    logger.error(
      { undrained: outcome.undrained, duration_ms: outcome.duration_ms },
      'maia.shutdown_incomplete_forcing_exit',
    );
    process.exit(config.SHUTDOWN_FORCED_EXIT_CODE);
  }
  // Clean drain: let the event loop empty on its own — no premature
  // `process.exit(0)`. The unref'd backstop below only fires if a leaked
  // handle is keeping the loop alive, and a natural exit always wins the race.
  const backstop = setTimeout(() => {
    lifecycle.recordForcedShutdown('handles_still_open');
    logger.warn(
      { timeout_ms: config.SHUTDOWN_EXIT_TIMEOUT_MS },
      'maia.exit_backstop_fired — open handles kept the loop alive after a clean drain',
    );
    process.exit(0);
  }, config.SHUTDOWN_EXIT_TIMEOUT_MS);
  backstop.unref?.();
}
