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
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { ensureRedisConnect } from '@/lib/redis.js';
import { startBaileys } from '@/gateway/baileys.js';
import { startAgentWorker } from '@/gateway/queue.js';
import { runAgentTurnJob } from '@/runtime/turns/job-consumer.js';
import { startServer } from '@/server.js';
import { audit } from '@/governance/audit.js';
import { probeDb } from '@/db/client.js';
import { startWorkers } from '@/workers/index.js';
import { lifecycle, StartupAbortedError } from '@/runtime/lifecycle/controller.js';
import { checkSchemaVersion } from '@/runtime/lifecycle/schema-version.js';
import { roleOwns, roleRequires } from '@/runtime/lifecycle/roles.js';
import {
  installSignalHandlers,
  registerShutdownSequence,
  setHttpApp,
} from '@/runtime/lifecycle/shutdown-sequence.js';

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

  // Every phase below runs through `lifecycle.runStartupStep`, which aborts
  // the boot at the first checkpoint after a stop signal and serializes
  // against the shutdown sequence (review round 1, P1 on `src/index.ts:319`).
  // Without it, a SIGTERM mid-boot drained and closed everything while
  // `main()` was still awaiting a slow dependency — and then the boot went on
  // to start HTTP, BullMQ, the crons and Baileys on a `stopped` process.

  // ── 1. config + secrets ────────────────────────────────────────────────
  await lifecycle.runStartupStep('config', async () => {
    // Spec roteamento v4 §1.4 — strict RECUSA ligar sem keyring válido: um miss
    // em strict é estagiado CIFRADO; sem chave, seria perda de mensagem. O
    // parse lança (fail-closed) e o boot para aqui com o erro explícito.
    if (config.MAIA_CHANNEL_ROUTING_MODE === 'strict') {
      const { parseKeyring } = await import('@/gateway/staging-crypto.js');
      parseKeyring();
      logger.info('routing.strict_keyring_validated');
    }
    lifecycle.setComponent('config', 'ready');
  });

  // ── 2. PostgreSQL ──────────────────────────────────────────────────────
  await lifecycle.runStartupStep('db', async () => {
    lifecycle.setComponent('db', 'starting');
    if (!(await probeDb())) {
      throw new Error('database unreachable at startup (SELECT 1 failed)');
    }
    lifecycle.setComponent('db', 'ready');
  });

  // ── 3. schema / migration version ──────────────────────────────────────
  await lifecycle.runStartupStep('schema', async () => {
    if (!config.READINESS_SCHEMA_CHECK) {
      lifecycle.setComponent('schema', 'ready', 'schema check disabled by config');
      return;
    }
    const schema = await checkSchemaVersion();
    if (schema.status !== 'ok') {
      lifecycle.setComponent('schema', 'failed', schema.detail);
      throw new Error(
        `schema version incompatible (expected ${schema.expected ?? '?'}, applied ${schema.applied ?? 'none'}) — run npm run db:migrate`,
      );
    }
    lifecycle.setComponent('schema', 'ready', `applied ${schema.applied}`);
  });

  // ── 4. Redis (MANDATORY — fail-closed) ─────────────────────────────────
  await lifecycle.runStartupStep('redis', async () => {
    lifecycle.setComponent('redis', 'starting');
    await ensureRedisConnect();
    lifecycle.setComponent('redis', 'ready');
  });

  // ── 5. best-effort boot chores (never gate readiness) ──────────────────
  await lifecycle.runStartupStep('boot_chores', async () => {
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
    //
    // Lives in `boot_chores` (right after the Redis phase, next to its twin,
    // the policy-cache subscriber) rather than under `roleOwns(agent_worker)`:
    // the call itself does NO I/O — it flips a flag, and the ioredis connection
    // is built lazily by the first tenant that actually caches something. That
    // laziness IS the role-awareness, and it is more accurate than a static
    // gate would be: the agent worker is not the only prompt builder (the
    // playground drain, the synthetic probe and the briefings are crons), so
    // gating on `agent_worker` would silently degrade the scheduler role to an
    // un-invalidatable — hence declined — cache.
    const { startTurnContextCacheInvalidationSubscriber } = await import(
      '@/agent/turn-context/cache.js'
    );
    startTurnContextCacheInvalidationSubscriber();
    if (config.FEATURE_TURN_CONTEXT_CACHE) {
      logger.info('turn_context.cache_invalidation_subscriber_started');
    }

    // Issue #508: mesma ideia para o cache de settings de modelo do LLM
    // Gateway. Sem isto, trocar o modelo pelo Admin só valia na réplica que
    // atendeu o request; as demais serviam o modelo antigo até o TTL curto
    // expirar — justamente durante o incidente que motivou a troca.
    //
    // Vive em `boot_chores`, ao lado dos seus dois gêmeos (policy cache e
    // turn-context cache), e NÃO sob `roleOwns`: qualquer role que chame o LLM
    // precisa enxergar a troca de modelo, e crons/probe/playground chamam sem
    // ser `agent_worker`. Ele abre conexão ioredis PRÓPRIA (ioredis proíbe
    // outros comandos num cliente inscrito), então é fechado explicitamente no
    // passo `llm_settings_subscriber` da sequência de drain — foi exatamente
    // um socket assim, deixado aberto, que fazia todo deploy limpo reportar
    // shutdown forçado na #512.
    const { startLLMSettingsInvalidationSubscriber } = await import(
      '@/lib/llm/cache-invalidation.js'
    );
    startLLMSettingsInvalidationSubscriber();
  });

  // ── 6. HTTP (probes answer 503 while `starting`) ───────────────────────
  await lifecycle.runStartupStep('http', async () => {
    if (roleOwns(role, 'http')) {
      lifecycle.setComponent('http', 'starting');
      setHttpApp(await startServer());
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
  });

  // ── 7. queues + BullMQ workers ─────────────────────────────────────────
  await lifecycle.runStartupStep('queues', async () => {
    if (!roleOwns(role, 'queue')) return;
    lifecycle.setComponent('queue', 'starting');
    const ownsWorker = roleOwns(role, 'agent_worker');
    if (ownsWorker) {
      lifecycle.setComponent('agent_worker', 'starting');
      // Issue #504 §Contrato do job — o worker recebe o payload JÁ classificado
      // (`parsed`) pela leitura dual do `queue.ts` e despacha por
      // `runAgentTurnJob`: V1 chama `runAgentForMensagem` como sempre, V2
      // resolve o escopo cross-tenant antes de qualquer trabalho de domínio.
      // Ver `src/runtime/turns/job-consumer.ts`.
      startAgentWorker(async (_job, parsed, facts) => {
        await runAgentTurnJob(parsed, facts);
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
    }
    // Constructing a Queue/Worker does NOT mean it can consume — the BullMQ
    // connection is lazy. Wait for a live connection before claiming ready, or
    // `/readyz` answers 200 on evidence that is merely "the object exists"
    // (review round 1, P1 on `src/index.ts:170`). With
    // `READINESS_BACKLOG_MAX=0` (the default) this flag is the ONLY thing
    // readiness knows about the queue, so it has to be true.
    const { awaitQueueReady } = await import('@/gateway/queue.js');
    await awaitQueueReady({ includeWorkers: ownsWorker });
    lifecycle.setComponent('queue', 'ready');
    if (ownsWorker) lifecycle.setComponent('agent_worker', 'ready');
  });

  // ── 8. cron scheduler ──────────────────────────────────────────────────
  await lifecycle.runStartupStep('cron_scheduler', async () => {
    if (!roleOwns(role, 'cron_scheduler')) return;
    startWorkers(1);
    lifecycle.setComponent('cron_scheduler', 'ready');
  });

  // ── 9. WhatsApp sessions ───────────────────────────────────────────────
  await lifecycle.runStartupStep('whatsapp_session', async () => {
    if (!roleOwns(role, 'whatsapp_session')) return;
    // NOTE: the component reaches `ready` from the Baileys `connection.update
    // = open` handler, NOT here. `startBaileys()` returns as soon as the
    // socket is armed — long before it is usable — so marking it ready here
    // made a never-paired cold start indistinguishable from a mere reconnect
    // (review round 1, P1 on `src/index.ts:189`).
    lifecycle.setComponent('whatsapp_session', 'starting');
    await startBaileys();
    // Fase 3 do roteamento multi-linha: sobe as sessões das linhas adicionais
    // (canais whatsapp ativos com auth pareado). No-op com MAIA_MULTI_LINE=false.
    const { startAdditionalLineSessions } = await import('@/gateway/line-sessions.js');
    await startAdditionalLineSessions().catch((err) =>
      logger.error({ err: (err as Error).message }, 'line_sessions.boot_failed'),
    );

    // Review round 2 (P1 on `src/index.ts:189`): fixing `/readyz` was not
    // enough — the PROCESS state was still lying. The lifecycle transition to
    // `ready`, the `system_started` audit row and `/startupz` (which reads that
    // state) all used to happen right after the socket was ARMED. So the audit
    // trail claimed the system had started at a moment when `/readyz` was
    // deliberately answering 503 and the instance could not send a single
    // message. All three now wait on the same criterion the component uses:
    // the first `connection.update = open`.
    //
    // Deliberately UNBOUNDED (interruptible by a stop signal). On expiry there
    // would be no honest move: proceeding announces a startup that did not
    // happen, and failing turns a cold start into a restart loop that makes
    // pairing impossible. Waiting — visibly, via the 30s heartbeat — is the
    // truthful state, and `/livez` plus `/setup` stay available throughout.
    if (!roleRequires(role, 'whatsapp_session')) return;
    if (lifecycle.getComponent('whatsapp_session').state === 'ready') return;
    logger.warn(
      { role },
      'maia.awaiting_whatsapp_open — startup is NOT complete until the session opens; on a cold start, pair via /setup',
    );
    const opened = await lifecycle.waitForComponent(
      'whatsapp_session',
      (s) => s === 'ready',
      { heartbeatMs: 30_000 },
    );
    // `aborted` = a stop signal arrived; `runStartupStep`'s post-await check
    // turns that into a clean `StartupAbortedError` right after this returns.
    if (opened === 'matched') logger.info('maia.whatsapp_session_open');
  });

  // ── 10. ready ──────────────────────────────────────────────────────────
  // `system_started` lands HERE — after every mandatory dependency for this
  // role was verified, not before (issue #512).
  lifecycle.assertStartupNotAborted('ready');
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

main().catch(async (err) => {
  // A stop signal mid-boot is NOT a failure — it is a rolling deploy killing a
  // slow pod. The shutdown is already running (that is what aborted us); just
  // wait for it and exit cleanly, without an `system_start_failed` row that
  // would make every deploy look like an incident.
  if (err instanceof StartupAbortedError) {
    logger.warn({ step: err.step }, 'maia.startup_aborted_by_shutdown');
    await lifecycle.shutdown({ reason: 'startup_aborted' }).catch(() => undefined);
    return;
  }
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
