import Fastify from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import {
  checkAll,
  checkDb,
  checkRedis,
  checkWhatsApp,
  toPublicHealthReport,
} from '@/lib/healthcheck.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import { checkRoleReadiness, checkStartup } from '@/runtime/lifecycle/readiness.js';
import { renderPrometheus, setGaugeProvider } from '@/lib/metrics.js';
import { isRedisConnected } from '@/lib/redis.js';
import { isBaileysConnected } from '@/gateway/baileys.js';
import { isDbConnected, probeDb } from '@/db/client.js';
import { startRedisMemoryCollector } from '@/observability/redis-memory-collector.js';
import { registerTurnStateGauges } from '@/observability/turn-state-collector.js';
import { registerQueueGauges } from '@/observability/queue-metrics.js';
import { registerRuntimeObservability } from '@/observability/register.js';
import { agentQueue, unroutedQueue } from '@/gateway/queue.js';

export async function buildServer() {
  const app = Fastify({ logger: false });

  // Issue #512 — `maia_lifecycle_state{role,state}` (one series per state,
  // exactly one of them 1). Idempotent: buildServer() runs many times in tests.
  lifecycle.registerGauges();

  setGaugeProvider('maia_redis_connected', () => (isRedisConnected() ? 1 : 0));
  setGaugeProvider('maia_baileys_connected', () => (isBaileysConnected() ? 1 : 0));
  setGaugeProvider('maia_db_connected', () => (isDbConnected() ? 1 : 0));

  // #503 — `maia_turns_current{status}` e `maia_turn_state_age_seconds{status}`:
  // turno preso e envelhecimento por estado, os riscos centrais da máquina de
  // estados. Snapshot compartilhado com TTL — um scrape faz uma query, não uma
  // por série.
  registerTurnStateGauges();

  // Issue #514 §5 (Fila) — queue depth per state + oldest waiting job age.
  // Complements #503's turn-state gauges: those measure where turns are stuck
  // in the STATE MACHINE, these measure the BullMQ backlog feeding it. A
  // latency incident needs both to be attributable.
  //
  // Registered as scrape-time gauges so the numbers stay correct with multiple
  // replicas: every replica reports the same shared Redis queue, and a
  // `max by (queue, state)` in the recording rules collapses the duplicates.
  registerQueueGauges(agentQueue, 'agent');
  registerQueueGauges(unroutedQueue, 'unrouted-replay');

  // Issue #535 §1/§2 — the families #514 declared but never emitted: pg pool
  // saturation, WhatsApp session presence/age and scheduler lag, plus the OTLP
  // span exporter. All inert by default: the gauges are scrape-time providers
  // (no work until a scrape) and the exporter does nothing without
  // `MAIA_OTLP_TRACES_ENDPOINT`. Awaited so a registration failure surfaces at
  // boot rather than as a silently missing series during an incident.
  await registerRuntimeObservability();

  // Sonda sintética (spec §1.6) — sinal PRIMÁRIO de outage, DURÁVEL (lido de
  // synthetic_probe_state.last_ok_at, não in-memory): segundos desde o último
  // OK. Um valor que CRESCE É o outage e sobrevive a restart. Provider async,
  // sem ALS (scrape). Inerte (0) com a flag off / antes do primeiro OK.
  setGaugeProvider('synthetic_probe_seconds_since_last_ok', async () => {
    if (!config.MAIA_SYNTHETIC_PROBE) return 0;
    const { syntheticProbeRepo } = await import('@/db/repositories/synthetic-probe-repos.js');
    const { PROBE_TENANT_ID, PROBE_AGENT_ID } = await import('@/probe/constants.js');
    return syntheticProbeRepo.secondsSinceLastOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
  });

  // Refresh the cached DB connectivity state in the background. Each call
  // self-throttles to 5s, so this is cheap regardless of the scrape rate.
  // Driven by setInterval so the gauge updates even when /metrics is idle.
  const dbProbeTimer = setInterval(() => {
    probeDb().catch(() => undefined);
  }, 5000);
  dbProbeTimer.unref?.();
  // Initial probe so the gauge is correct on the first scrape after boot.
  probeDb().catch(() => undefined);

  // Issue #297 — Redis memory pressure gauges (used_memory / maxmemory /
  // ratio / evicted_keys / rejected_connections). Periodic INFO collection
  // populates a snapshot that the gauge providers read on each scrape.
  // The timer self-`unref()`s so it never blocks a clean process exit, but
  // we still capture the handle and stop it on `onClose` so repeated
  // buildServer()/app.close() cycles (tests, hot reload) don't leak untracked
  // intervals — and `dbProbeTimer` is cleared there too for the same reason.
  const redisMemoryCollector = startRedisMemoryCollector();
  app.addHook('onClose', async () => {
    clearInterval(dbProbeTimer);
    redisMemoryCollector.stop();
    // Issue #535 — stop the OTLP batch timer and make one last flush attempt,
    // so the spans of the turns that ran just before a deploy are not the ones
    // an operator loses.
    const { stopOtlpExporter } = await import('@/observability/otlp-exporter.js');
    await stopOtlpExporter();
  });

  // Issue #512 — three DISTINCT probes with three distinct jobs.
  //
  // /livez     — is the process alive? NO I/O at all: no DB, no Redis, no
  //              WhatsApp, no disk. A liveness probe that touches a dependency
  //              turns a dependency outage into a restart loop.
  // /startupz  — did initialization finish? Positive once the lifecycle
  //              reached `ready`; stays positive while draining so a slow
  //              drain is not killed by a "failed startup" verdict.
  // /readyz    — should the load balancer route here? Composite and
  //              ROLE-AWARE (see src/runtime/lifecycle/roles.ts), fail-closed,
  //              read-only, cached.
  app.get('/livez', async (_req, reply) => {
    const snap = lifecycle.snapshot();
    reply.code(200);
    return {
      live: true,
      state: snap.state,
      role: snap.role,
      instance_id: snap.instance_id,
      uptime_ms: snap.uptime_ms,
    };
  });
  app.get('/startupz', async (_req, reply) => {
    const report = checkStartup();
    reply.code(report.started ? 200 : 503);
    return report;
  });
  app.get('/readyz', async (_req, reply) => {
    const report = await checkRoleReadiness();
    reply.code(report.ready ? 200 : 503);
    return report;
  });

  // `/health` is the component view for humans and the container healthcheck.
  // Issue #512: it is now READ-ONLY (no `system_health_events` rows per poll),
  // cached, and stripped of raw driver text before leaving the process.
  app.get('/health', async () => {
    const report = await checkAll();
    return { status: report.status, components: report.components.map(toPublicHealthReport) };
  });
  app.get('/health/db', async () => toPublicHealthReport(await checkDb()));
  app.get('/health/redis', async () => toPublicHealthReport(await checkRedis()));
  app.get('/health/whatsapp', async () => toPublicHealthReport(await checkWhatsApp()));
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return renderPrometheus();
  });

  // Setup pairing routes — mounted always (no flag gate). See spec §4.5.
  const { registerSetupRoutes } = await import('@/setup/index.js');
  await registerSetupRoutes(app);

  return app;
}

export async function startServer() {
  const app = await buildServer();
  const address = await app.listen({ host: '0.0.0.0', port: config.APP_PORT });
  logger.info({ address }, 'http.listening');
  return app;
}
