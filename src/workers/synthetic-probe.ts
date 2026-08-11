/**
 * Sonda sintética (spec §1) — worker cron `synthetic_probe`. Registrado em
 * PHASE 1 (correção do review: startWorkers(1) ignora phase>1, então phase 2
 * NUNCA roda) mas INERTE enquanto MAIA_SYNTHETIC_PROBE=false. A flag — não a
 * fase — é o gate de comportamento.
 *
 * Por tick, sob o contexto do tenant da sonda:
 *   1. retry durável do alerta pendente (§1.6) — barato, sempre;
 *   2. sweep de TTL dos runs órfãos (§1.5) — barato, sempre;
 *   3. UM run: single-flight por lease + auto-silêncio (segura o lease por
 *      backoff após N falhas, §1.5/§5). O run em si delega a `runProbeTick`.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { ingressUpsertMessage } from '@/gateway/baileys.js';
import { syntheticProbeRepo } from '@/db/repositories/synthetic-probe-repos.js';
import { runProbeTick, type ProbeTickDeps } from '@/probe/probe.js';
import { pickScenario } from '@/probe/scenarios.js';
import { judgeReply } from '@/probe/judge.js';
import { findInboundMensagemIdByWid, latestOutboundText } from '@/probe/queries.js';
import { PROBE_AGENT_ID, PROBE_CONTEXT, PROBE_TENANT_ID } from '@/probe/constants.js';

/**
 * Entrega do alerta respeitando o modo (§4): 'log_only' (default staging) emite
 * log e "entrega" (o log sempre sucede); 'alert' usa sendAlert com sinal de
 * entrega para o retry durável. O gauge é o sinal PRIMÁRIO nos dois modos.
 */
async function deliverAlert(input: { subject: string; body: string }): Promise<boolean> {
  if (config.MAIA_PROBE_ALERT_MODE === 'log_only') {
    logger.error({ subject: input.subject, body: input.body }, 'synthetic_probe.alert_log_only');
    return true;
  }
  const { sendAlertWithDelivery } = await import('@/lib/alerts.js');
  const { delivered } = await sendAlertWithDelivery(input);
  return delivered;
}

/** Retry durável do alerta pendente (§1.6). */
async function retryPendingAlert(): Promise<void> {
  const state = await syntheticProbeRepo.getState(PROBE_TENANT_ID, PROBE_AGENT_ID);
  if (!state?.alert_pending) return;
  const delivered = await deliverAlert({
    subject: 'Sonda sintética: DEGRADADA (retry)',
    body:
      `Reentrega do alerta de degradação. consecutive_failures=${state.consecutive_failures}, ` +
      `last_ok_at=${state.last_ok_at ? state.last_ok_at.toISOString() : 'nunca'}.`,
  });
  await syntheticProbeRepo.recordAlertAttempt({
    tenant_id: PROBE_TENANT_ID,
    agent_id: PROBE_AGENT_ID,
    delivered,
  });
}

/** Sweep de TTL dos runs órfãos (§1.5) — cleanup do tráfego + fecha o run.
 *  Escopado por (tenant, agent) em todas as chamadas (correção do review). */
async function sweepOrphanRuns(nowMs: number): Promise<void> {
  const scope = { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID };
  const cutoff = new Date(nowMs - config.MAIA_PROBE_RUN_TTL_MS);
  const open = await syntheticProbeRepo.listOpenRunsOlderThan(scope, cutoff, 100);
  for (const run of open) {
    if (run.mensagem_id) {
      await syntheticProbeRepo.cleanupRunTraffic({
        tenant_id: PROBE_TENANT_ID,
        agent_id: PROBE_AGENT_ID,
        mensagem_id: run.mensagem_id,
      });
    }
    await syntheticProbeRepo.closeOrphanRun(scope, run.id);
  }
  if (open.length > 0) logger.info({ swept: open.length }, 'synthetic_probe.ttl_sweep');
}

function buildDeps(): ProbeTickDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    routingMode: config.MAIA_CHANNEL_ROUTING_MODE,
    scenario: pickScenario(Date.now()),
    ingress: (msg, line) => ingressUpsertMessage(msg, line),
    resolveInboundId: findInboundMensagemIdByWid,
    latestReplyText: latestOutboundText,
    repo: syntheticProbeRepo,
    judge: { enabled: config.MAIA_PROBE_LLM_JUDGE, run: judgeReply },
    audit,
    metrics: { inc: incCounter, observe: observeHistogram },
    deliverAlert,
    sloMs: config.MAIA_PROBE_SLO_MS,
    slowMs: config.MAIA_PROBE_SLO_WARN_MS,
    alertAfterK: config.MAIA_PROBE_ALERT_AFTER_K,
    pollIntervalMs: 1000,
    logger,
  };
}

export async function runSyntheticProbe(): Promise<void> {
  if (!config.MAIA_SYNTHETIC_PROBE) return; // inerte com a flag off

  await runWithTenantContext(PROBE_CONTEXT, async () => {
    const nowMs = Date.now();

    await retryPendingAlert().catch((err) =>
      logger.warn({ err: (err as Error).message }, 'synthetic_probe.alert_retry_failed'),
    );
    await sweepOrphanRuns(nowMs).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'synthetic_probe.ttl_sweep_failed'),
    );

    // Single-flight + auto-silêncio (§1.5): se o lease não é adquirível (run em
    // voo OU backoff de silêncio segurando o lease), no-op silencioso.
    const acquired = await syntheticProbeRepo.acquireLease({
      tenant_id: PROBE_TENANT_ID,
      agent_id: PROBE_AGENT_ID,
      lease_ms: config.MAIA_PROBE_LEASE_MS,
    });
    if (!acquired) return;

    let result: Awaited<ReturnType<typeof runProbeTick>> | undefined;
    try {
      result = await runProbeTick(buildDeps());
    } finally {
      // Auto-silêncio: após N falhas consecutivas, SEGURA o lease pelo backoff
      // (os próximos ticks no-opam → zero custo de LLM). Senão, libera.
      if (result && result.consecutiveFailures >= config.MAIA_PROBE_AUTOSILENCE_AFTER_N) {
        await syntheticProbeRepo.holdLease(
          PROBE_TENANT_ID,
          PROBE_AGENT_ID,
          config.MAIA_PROBE_SILENCED_BACKOFF_MS,
        );
        logger.warn(
          { consecutive_failures: result.consecutiveFailures },
          'synthetic_probe.auto_silenced',
        );
      } else {
        await syntheticProbeRepo.releaseLease(PROBE_TENANT_ID, PROBE_AGENT_ID);
      }
    }
  });
}
