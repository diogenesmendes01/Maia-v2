/**
 * Process entrypoint — ORDERED startup and a real graceful shutdown
 * (issue #512).
 *
 * What changed and why:
 *
 *   - `system_started` used to be audited on the FIRST line of `main()`,
 *     before a single dependency had been verified. A process that could not
 *     reach Redis still wrote "started", listened on HTTP and looked healthy.
 *     It is now audited at the `ready` transition, after every mandatory
 *     dependency for this process ROLE has been checked.
 *   - `ensureRedisConnect()` swallowed its failure (warning only). It is now
 *     fail-closed (`RedisUnavailableError`) and a failure here marks the
 *     lifecycle `failed`, drains whatever was already opened and exits
 *     non-zero — never "log and keep going" (AGENTS.md §4.2).
 *   - shutdown used to call `stopWorkers()` (fire-and-forget) and then
 *     `process.exit(0)`, without closing BullMQ, the primary Baileys socket or
 *     the additional line sessions. The drain below stops accepting work
 *     FIRST, awaits in-flight work within `SHUTDOWN_GRACE_MS`, then closes
 *     resources in dependency order (consumers before the pools they use).
 *
 * HTTP still starts EARLY, on purpose: the `/setup` pairing UI must be
 * reachable during a cold start (before Baileys can connect at all). Issue
 * #512 §4 sanctions this explicitly — `/startupz` and `/readyz` stay 503 until
 * the lifecycle reaches `ready`, so an early listener never means "in
 * rotation".
 */
import type { FastifyInstance } from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { ensureRedisConnect } from '@/lib/redis.js';
import { startBaileys } from '@/gateway/baileys.js';
import { startAgentWorker } from '@/gateway/queue.js';
import { runAgentForMensagem } from '@/agent/core.js';
import { startServer } from '@/server.js';
import { audit } from '@/governance/audit.js';
import { shutdownPools } from '@/lib/healthcheck.js';
import { probeDb } from '@/db/client.js';
import { startWorkers, stopWorkers } from '@/workers/index.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { checkSchemaVersion } from '@/runtime/lifecycle/schema-version.js';
import { roleOwns } from '@/runtime/lifecycle/roles.js';

/**
 * Held at module scope so the shutdown sequence can be registered BEFORE the
 * server exists (a SIGTERM mid-boot must still drain), and still close the
 * app once it does.
 */
let httpApp: FastifyInstance | null = null;

async function main() {
  const role = lifecycle.setRole(config.MAIA_PROCESS_ROLE);
  logger.info(
    {
      env: config.NODE_ENV,
      port: config.APP_PORT,
      role,
      instance_id: lifecycle.instanceId,
      grace_ms: config.SHUTDOWN_GRACE_MS,
    },
    'maia.starting',
  );

  // Signals and the shutdown sequence are wired BEFORE the long startup so a
  // SIGTERM during boot (or a fail-closed abort) drains whatever is already
  // open instead of killing the process mid-initialization. Every step is a
  // no-op when its component was never started.
  installSignalHandlers();
  registerShutdownSequence();

  // ── 1. config + secrets ────────────────────────────────────────────────
  // Spec roteamento v4 §1.4 — strict RECUSA ligar sem keyring válido: um miss
  // em strict é estagiado CIFRADO; sem chave, seria perda de mensagem. O
  // parse lança (fail-closed) e o boot para aqui com o erro explícito.
  if (config.MAIA_CHANNEL_ROUTING_MODE === 'strict') {
    const { parseKeyring } = await import('@/gateway/staging-crypto.js');
    parseKeyring();
    logger.info('routing.strict_keyring_validated');
  }
  lifecycle.setComponent('config', 'ready');

  // ── 2. PostgreSQL ──────────────────────────────────────────────────────
  lifecycle.setComponent('db', 'starting');
  if (!(await probeDb())) {
    throw new Error('database unreachable at startup (SELECT 1 failed)');
  }
  lifecycle.setComponent('db', 'ready');

  // ── 3. schema / migration version ──────────────────────────────────────
  if (config.READINESS_SCHEMA_CHECK) {
    const schema = await checkSchemaVersion();
    if (schema.status !== 'ok') {
      lifecycle.setComponent('schema', 'failed', schema.detail);
      throw new Error(
        `schema version incompatible (expected ${schema.expected ?? '?'}, applied ${schema.applied ?? 'none'}) — run npm run db:migrate`,
      );
    }
    lifecycle.setComponent('schema', 'ready', `applied ${schema.applied}`);
  } else {
    lifecycle.setComponent('schema', 'ready', 'schema check disabled by config');
  }

  // ── 4. Redis (MANDATORY — fail-closed) ─────────────────────────────────
  lifecycle.setComponent('redis', 'starting');
  await ensureRedisConnect();
  lifecycle.setComponent('redis', 'ready');

  // ── 5. best-effort boot chores (never gate readiness) ──────────────────
  // B3b: clean up any orphan PDF reports from a prior crash. Best-effort.
  const { sweepPdfTmp } = await import('@/lib/pdf/_sweeper.js');
  await sweepPdfTmp().catch((err) => logger.warn({ err }, 'pdf.sweeper.boot_failed'));

  // SETUP: ensure bootstrap token exists (cold-start / first deploy).
  // Token NOT logged in plaintext — operator must SSH and read the file.
  const { ensureToken } = await import('@/setup/token.js');
  const { hasValidBaileysSession } = await import('@/setup/state.js');
  await ensureToken();
  if (!(await hasValidBaileysSession(config.BAILEYS_AUTH_DIR))) {
    logger.warn(
      { setup_token_path: '<BAILEYS_AUTH_DIR>/setup-token.txt' },
      'setup.bootstrap_token_ready — run `cat $BAILEYS_AUTH_DIR/setup-token.txt` and visit /setup',
    );
  }

  // P8e: cross-instance policy cache invalidation. Subscriber is idempotent.
  // Codex review #93: previously this was defined but never called,
  // leaving stale positive/negative cache entries until natural TTL.
  const { startPolicyCacheInvalidationSubscriber } = await import(
    '@/control-plane/policy/index.js'
  );
  startPolicyCacheInvalidationSubscriber();
  logger.info('policy_resolver.cache_invalidation_subscriber_started');

  // Issue #511: cross-replica invalidation for the turn-context cache
  // (identity / capabilities / gaps). Idempotent, and a no-op while
  // FEATURE_TURN_CONTEXT_CACHE is off — with nothing cached there is nothing to
  // invalidate, and an idle subscriber connection per replica is not free.
  const { startTurnContextCacheInvalidationSubscriber } = await import(
    '@/agent/turn-context/cache.js'
  );
  startTurnContextCacheInvalidationSubscriber();
  if (config.FEATURE_TURN_CONTEXT_CACHE) {
    logger.info('turn_context.cache_invalidation_subscriber_started');
  }

  // ── 6. HTTP (probes answer 503 while `starting`) ───────────────────────
  if (roleOwns(role, 'http')) {
    lifecycle.setComponent('http', 'starting');
    httpApp = await startServer();
    lifecycle.setComponent('http', 'ready');
  }
  // The Redis memory collector is started by `buildServer()`; its readings are
  // what the `redis_memory` gate reads at probe time.
  lifecycle.setComponent('redis_memory', 'ready');

  // Sonda sintética (spec §1.3 / review P1-C) — carrega o sink ANTES do worker
  // de agente: a impossibilidade de envio físico a um canal is_synthetic vale
  // independente da flag (cobre um job antigo na fila mesmo no kill-switch). Com
  // a flag on, valida fail-fast o triplete configurado (boot FALHA se não for
  // exclusivamente sintético). No-op de validação com a flag off.
  const { initSyntheticProbe } = await import('@/probe/boot-validate.js');
  await initSyntheticProbe();

  // ── 7. queues + BullMQ workers ─────────────────────────────────────────
  if (roleOwns(role, 'queue')) {
    lifecycle.setComponent('queue', 'ready');
  }
  if (roleOwns(role, 'agent_worker')) {
    lifecycle.setComponent('agent_worker', 'starting');
    startAgentWorker(async (job) => {
      await runAgentForMensagem(job.data.mensagem_id);
    });
    // Spec roteamento v4 §1.4 — worker de replay do staging (job só carrega o
    // id; o payload cifrado vive no Postgres). Ativo em qualquer modo: rows só
    // existem se o strict as criou, e o replay precisa sobreviver a um
    // downgrade de modo (as pendentes ainda merecem entrega).
    const { startUnroutedReplayWorker } = await import('@/gateway/queue.js');
    const { processUnroutedReplay } = await import('@/gateway/unrouted-staging.js');
    startUnroutedReplayWorker(async (job) => {
      await processUnroutedReplay(job.data.unrouted_id);
    });
    lifecycle.setComponent('agent_worker', 'ready');
  }

  // ── 8. cron scheduler ──────────────────────────────────────────────────
  if (roleOwns(role, 'cron_scheduler')) {
    startWorkers(1);
    lifecycle.setComponent('cron_scheduler', 'ready');
  }

  // ── 9. WhatsApp sessions ───────────────────────────────────────────────
  if (roleOwns(role, 'whatsapp_session')) {
    lifecycle.setComponent('whatsapp_session', 'starting');
    await startBaileys();
    // Fase 3 do roteamento multi-linha: sobe as sessões das linhas adicionais
    // (canais whatsapp ativos com auth pareado). No-op com MAIA_MULTI_LINE=false.
    const { startAdditionalLineSessions } = await import('@/gateway/line-sessions.js');
    await startAdditionalLineSessions().catch((err) =>
      logger.error({ err: (err as Error).message }, 'line_sessions.boot_failed'),
    );
    lifecycle.setComponent('whatsapp_session', 'ready');
  }

  // ── 10. ready ──────────────────────────────────────────────────────────
  // `system_started` lands HERE — after every mandatory dependency for this
  // role was verified, not before (issue #512).
  lifecycle.transitionTo('ready', 'startup_complete');
  await audit({
    acao: 'system_started',
    metadata: {
      role,
      instance_id: lifecycle.instanceId,
      components: lifecycle.snapshot().components.map((c) => `${c.component}=${c.state}`),
    },
  });
  logger.info({ role, instance_id: lifecycle.instanceId }, 'maia.ready');
}

/**
 * Shutdown sequence — issue #512 §5. Registration order IS execution order,
 * and the ordering rule is: stop accepting work → drain in-flight work →
 * close consumers → close the pools those consumers use. Closing Redis or
 * Postgres before their consumers is what used to kill a job mid-write.
 */
function registerShutdownSequence(): void {
  // 1. crons: stop scheduling, then await the tick already running.
  lifecycle.registerShutdownStep({
    name: 'cron_workers',
    timeoutMs: config.SHUTDOWN_GRACE_MS,
    run: async () => {
      const { pending } = await stopWorkers(config.SHUTDOWN_GRACE_MS / 2);
      if (pending.length > 0) {
        throw new Error(`cron jobs still active: ${pending.join(', ')}`);
      }
    },
  });

  // 2. tracked fire-and-forget work (reflection, trace enqueue, outbox flush).
  lifecycle.registerShutdownStep({
    name: 'background_tasks',
    run: async () => {
      const pending = await lifecycle.awaitBackgroundTasks(config.SHUTDOWN_GRACE_MS / 4);
      if (pending.length > 0) {
        throw new Error(`background tasks still active: ${pending.join(', ')}`);
      }
    },
  });

  // 3. additional WhatsApp lines, then the primary socket. Lines first so a
  //    per-line reconnect timer can never resurrect a socket after the primary
  //    session is gone (review #498 alto 3 keeps the timers cancelled).
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

  // 4. BullMQ. `worker.close()` waits for the ACTIVE job to finish — this is
  //    the queue drain the old shutdown never performed. A job that outlives
  //    the deadline stays in Redis (BullMQ re-delivers on stalled), so
  //    unfinished work remains recoverable.
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

  // 5. HTTP. Fastify's `onClose` hooks stop the Redis memory collector and the
  //    DB probe timer, so this must run before the pools close.
  lifecycle.registerShutdownStep({
    name: 'http',
    run: async () => {
      if (!httpApp) return;
      await httpApp.close();
      lifecycle.setComponent('http', 'stopped');
    },
  });

  // 6. audit — still needs the DB pool, hence before `pools`.
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

  // 7. pools LAST.
  lifecycle.registerShutdownStep({
    name: 'pools',
    run: async () => {
      await shutdownPools();
      lifecycle.setComponent('db', 'stopped');
      lifecycle.setComponent('redis', 'stopped');
    },
  });
}

function installSignalHandlers(): void {
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

async function runShutdown(signal: string): Promise<void> {
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

main().catch(async (err) => {
  logger.error({ err }, 'maia.fatal');
  lifecycle.transitionTo('failed', (err as Error)?.message ?? 'startup_failed');
  // Fail-closed with cleanup: whatever was already opened still gets closed,
  // so a crash-looping deploy does not leak sockets and pool connections.
  await audit({
    acao: 'system_start_failed',
    metadata: {
      role: lifecycle.role,
      instance_id: lifecycle.instanceId,
      error: (err as Error)?.message,
    },
  }).catch(() => undefined);
  await lifecycle.shutdown({ reason: 'startup_failed' }).catch(() => undefined);
  process.exit(1);
});
