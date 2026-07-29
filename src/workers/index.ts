import cron, { type ScheduledTask } from 'node-cron';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter, setGaugeProvider, _internal as metricsInternal } from '@/lib/metrics.js';
import { runHealthMonitor } from './health-monitor.js';
import { runPendingExpirer } from './pending-expirer.js';
import { runIdempotencyCleanup } from './idempotency-cleanup.js';
import { runAuditModeExpirer } from './audit-mode-expirer.js';
import { runInactivitySweep } from './inactivity-sweep.js';
import { runConversationSummarizer } from './conversation-summarizer.js';
import { runReflectionBatch } from './reflection-batch.js';
import { runPatternDetector } from './pattern-detector.js';
import { runMessageRecovery } from './message-recovery.js';
import { runPendingReminder } from './pending-reminder.js';
import { runScheduling } from './scheduling-tick.js';
import { runOutboxDrainWorker } from './outbox-drain-worker.js';
import { runUnroutedRecovery } from './unrouted-recovery.js';
import { runSeriesNextSchedulerWorker } from './series-next-scheduler.js';
import { runNightlyBackup, runCloudBackupRotation } from './backup.js';
import { runCostMonitor } from './cost-monitor.js';
import { runAuditWatcher } from './audit-watcher.js';
import { runDlqMonitor } from './dlq-monitor.js';
import { runMorningBriefing, runEveningBriefing, runWeeklyBriefing } from './briefings.js';
import { runLegacyMemoryReclassifier } from './legacy-memory-reclassifier.js';
import { runConfidenceRecompute } from './confidence-recompute.js';
import { runProcedureCandidateConsumer } from './procedure-candidate-consumer.js';
import { runProcedureExecutionReaper } from './procedure-execution-reaper.js';
import { runProcedureMetricsRefresh } from './procedure-metrics-refresh.js';
import { runDriftMonitor } from './drift-monitor.js';
import { runGapEscalationMonitor } from './gap-escalation-monitor.js';
import { runTraceBodyWriter } from './trace-body-writer.js';
import { runTraceBodyRecoverer } from './trace-body-recoverer.js';
import { runTraceMatviewRefresh } from './trace-matview-refresh.js';
import { runKnowledgeStatePromoter } from './knowledge-state-promoter.js';
import { runOutboundMessagesSweeper } from './outbound-messages-sweeper.js';
import { runIdempotencyOutboxRelayer } from './idempotency-outbox-relayer.js';
import { runWorkflowEngineTick } from './workflow-engine-tick.js';
import { runPlaygroundTurnWorker } from './playground-turn-worker.js';
import { runObjectiveExecuteWorker, runObjectivePerceiveWorker } from './objective-execute-worker.js';
import { runMcpSyncWorker } from './mcp-sync-worker.js';
import { runChannelPairingWorker } from './channel-pairing-worker.js';
import { runSyntheticProbe } from './synthetic-probe.js';

export type Job = {
  name: string;
  cron: string;
  fn: () => Promise<void>;
  phase: number;
};

export const JOBS: Job[] = [
  { name: 'health_monitor', cron: '*/1 * * * *', fn: runHealthMonitor, phase: 1 },
  { name: 'audit_watcher', cron: '*/1 * * * *', fn: runAuditWatcher, phase: 1 },
  { name: 'pending_expirer', cron: '*/1 * * * *', fn: runPendingExpirer, phase: 1 },
  { name: 'message_recovery', cron: '*/2 * * * *', fn: runMessageRecovery, phase: 1 },
  { name: 'pending_reminder', cron: '*/30 * * * *', fn: runPendingReminder, phase: 1 },
  // Spec 18 §10 — three scheduling workers:
  //  - scheduling_tick: every minute, claims due occurrences and advances
  //    state (also reclaims expired occurrence leases in the same pass).
  //  - outbox_drain: every minute, drains pending outbox messages under
  //    backpressure (also reclaims expired outbox leases in the same pass).
  //  - series_next_scheduler: every 10 min, backfills missing next-cycle
  //    occurrences for any active series whose chain was broken by a
  //    failure between completion and re-schedule.
  // Issue #355: scheduling tables (series/occurrences/tasks/outbox_messages)
  // carry tenant_id/agent_id (migrations 071/072/073) and every scheduling
  // query scopes by the ALS tenant context. Each of these three workers is now
  // a per-tenant DISPATCHER — it enumerates DISTINCT (tenant_id, agent_id)
  // tuples with work and opens runWithTenantContext per tuple, fail-isolated
  // (espelha reflection-batch #240/#251). Scheduling V2 is 100% cutover (#406
  // removed FEATURE_SCHEDULING_V2), so these run every tick and cleanly no-op
  // when no tenant has work.
  { name: 'scheduling_tick', cron: '* * * * *', fn: runScheduling, phase: 1 },
  { name: 'outbox_drain', cron: '* * * * *', fn: runOutboxDrainWorker, phase: 1 },
  // Spec roteamento v4 §1.4 — recovery sweep do staging de inbound
  // não-roteado (modo strict): expira TTL, re-arma jobs órfãos (jobId
  // estável ⇒ idempotente) e vigia o keyring. No-op barato sem rows.
  { name: 'unrouted_recovery', cron: '* * * * *', fn: runUnroutedRecovery, phase: 1 },
  // Issue #464 — admin-console sandbox chat: drains playground_turns
  // (Postgres-as-queue) inside the tick for ~50s, so effective chat latency
  // is seconds despite the 1-min cron. Non-critical surface → phase 2.
  { name: 'playground_turn_drain', cron: '* * * * *', fn: runPlaygroundTurnWorker, phase: 2 },
  // Issue #469 — work loop: percebe trabalho (perceptores por kind, 5min)
  // e executa tarefas pendentes (drain ~50s/tick). Fase 2: não-crítico.
  { name: 'objective_perceive', cron: '*/5 * * * *', fn: runObjectivePerceiveWorker, phase: 2 },
  { name: 'objective_execute', cron: '* * * * *', fn: runObjectiveExecuteWorker, phase: 2 },
  // Issue #478 — MCP: executa test/sync pedidos pelo console (ponte
  // Postgres-as-queue por flags; só o runtime tem rede para os servers).
  // Fase 0 cap. 5: PHASE 1 de propósito (mesmo padrão do synthetic_probe
  // abaixo) — startWorkers(1) ignora phase>1, então em phase 2 o worker
  // NUNCA rodava e o console mostrava test/sync "pendentes" para sempre
  // (UI desonesta). A FLAG é o gate real: com FEATURE_MCP_TOOLS off o
  // worker é no-op na primeira linha (nenhuma rede, nenhum secret).
  { name: 'mcp_sync', cron: '* * * * *', fn: runMcpSyncWorker, phase: 1 },
  // Issue #518 — ponte Admin→runtime do pareamento de linhas WhatsApp. O
  // console só tem Postgres; o socket Baileys vive aqui. Cadência de 5s
  // porque o operador está OLHANDO a tela esperando o QR — um cron de 1min
  // tornaria o fluxo inutilizável. PHASE 1 de propósito (startWorkers(1)
  // ignora phase>1); o custo em repouso é um probe em índice parcial
  // (`WHERE command IS NOT NULL`), que não retorna nada sem operador agindo.
  { name: 'channel_pairing', cron: '*/5 * * * * *', fn: runChannelPairingWorker, phase: 1 },
  { name: 'series_next_scheduler', cron: '*/10 * * * *', fn: runSeriesNextSchedulerWorker, phase: 1 },
  // Sonda sintética (spec 2026-07-17 §1.1). PHASE 1 de propósito: startWorkers(1)
  // ignora phase>1, então phase 2 NUNCA seria agendado (correção do review). É
  // seguro em phase 1 porque o worker é NO-OP com MAIA_SYNTHETIC_PROBE=false
  // (default) — a flag, não a fase, é o gate. Cadência configurável (default
  // */10). Sob shadow o worker falha fechado (no-op + audit); só age em
  // exact_first/strict com o canal de sonda pareado (§1.2).
  { name: 'synthetic_probe', cron: config.MAIA_PROBE_CRON, fn: runSyntheticProbe, phase: 1 },
  // Issue #345 (Phase 4 of #323), Batch D — the inline body was EXTRACTED into
  // `./workflow-engine-tick.ts` (`runWorkflowEngineTick`) and converted from the
  // hardcoded `default/default` shim into a per-tenant dispatcher. The job SHAPE
  // is unchanged (same name/cadence/phase) — only the handler implementation
  // moved out. `runWorkflowEngineTick` enumerates the DISTINCT (tenant_id,
  // agent_id) tuples with active workflows and runs `tickEngine()` once per
  // tuple under `runWithTenantContext`, fail-isolated.
  { name: 'workflow_engine_tick', cron: '*/30 * * * * *', fn: runWorkflowEngineTick, phase: 1 },
  { name: 'audit_mode_expirer', cron: '*/15 * * * *', fn: runAuditModeExpirer, phase: 1 },
  { name: 'idempotency_cleanup', cron: '0 4 * * *', fn: runIdempotencyCleanup, phase: 1 },
  // Issue #292 — outbound_messages sweeper (#227/#233 follow-up).
  // Cadence ~5min: stale-pending cutoff é 5min default, então rodar a cada
  // 5min dá detecção em <=10min de qualquer pending órfã. Cleanup retention
  // (terminais > 30d) roda no mesmo pass (uma DELETE a mais por tenant).
  // Dispatcher per-tenant via runWithTenantContext (espelha reflection-batch
  // #240/#251) — NÃO usa sentinela 'default'.
  { name: 'outbound_messages_sweeper', cron: '*/5 * * * *', fn: runOutboundMessagesSweeper, phase: 1 },
  // Issue #316 — transactional effect outbox relayer. Dispatches NON-IDEMPOTENT
  // external effects (e.g. WhatsApp sends) recorded atomically with the winning
  // idempotency reservation, EXACTLY ONCE, with retry/backoff. Every minute so
  // proactive-message latency stays low. Single-flight (GLOBAL advisory lock)
  // + per-tenant fan-out — mirrors outbound_messages_sweeper. No featureFlag:
  // it's the only dispatch path for these effects once merged (the tool no
  // longer sends inline), so it must always run.
  { name: 'idempotency_outbox_relayer', cron: '*/1 * * * *', fn: runIdempotencyOutboxRelayer, phase: 1 },
  { name: 'inactivity_sweep', cron: '0 3 * * *', fn: runInactivitySweep, phase: 1 },
  { name: 'nightly_backup', cron: '0 3 * * *', fn: runNightlyBackup, phase: 1 },
  // Cloud backup rotation runs once a week (Sundays 04:00 BRT) so
  // BACKUP_RETENTION_CLOUD_DAYS is actually applied. Decoupled from the
  // nightly run so the upload path stays fast and rotation can be paused
  // independently if a provider has hiccups.
  { name: 'cloud_backup_rotation', cron: '0 4 * * 0', fn: runCloudBackupRotation, phase: 1 },
  { name: 'cost_monitor', cron: '30 2 * * *', fn: runCostMonitor, phase: 1 },
  { name: 'dlq_monitor', cron: '*/5 * * * *', fn: runDlqMonitor, phase: 1 },
  { name: 'conversation_summarizer', cron: '0 2 * * *', fn: runConversationSummarizer, phase: 2 },
  { name: 'reflection_batch', cron: '0 2 * * *', fn: runReflectionBatch, phase: 2 },
  { name: 'pattern_detector', cron: '0 4 * * *', fn: runPatternDetector, phase: 2 },
  { name: 'legacy_memory_reclassifier', cron: '0 3 * * *', fn: runLegacyMemoryReclassifier, phase: 2 },
  { name: 'confidence_recompute', cron: '30 3 * * *', fn: runConfidenceRecompute, phase: 2 },
  { name: 'procedure_candidate_consumer', cron: '0 2 * * *', fn: runProcedureCandidateConsumer, phase: 2 },
  { name: 'procedure_execution_reaper', cron: '0 * * * *', fn: runProcedureExecutionReaper, phase: 3 },
  { name: 'procedure_metrics_refresh', cron: '*/15 * * * *', fn: runProcedureMetricsRefresh, phase: 3 },
  { name: 'briefing_morning', cron: '0 8 * * *', fn: runMorningBriefing, phase: 4 },
  { name: 'briefing_evening', cron: '0 21 * * *', fn: runEveningBriefing, phase: 4 },
  { name: 'briefing_weekly', cron: '0 8 * * 1', fn: runWeeklyBriefing, phase: 4 },
  // P4 Task 10 — drift monitor semanal (domingo 03:00 BRT).
  { name: 'drift_monitor', cron: '0 3 * * 0', fn: runDriftMonitor, phase: 4 },
  // P5 Task 9 — gap escalation monitor (a cada 30min).
  { name: 'gap_escalation_monitor', cron: '*/30 * * * *', fn: runGapEscalationMonitor, phase: 5 },
  // P10a — knowledge state auto-promoter (hourly; matures ephemeral→observed→
  // reinforced→verified→active by evidence_count + age, and expires stale
  // rows to deprecated).
  { name: 'knowledge_state_promoter', cron: '0 * * * *', fn: runKnowledgeStatePromoter, phase: 2 },
  // P10b — runtime trace: 3 workers (body writer, body recoverer, matview refresh).
  // Registered at phase 1 so they are included in the production startup call
  // `startWorkers(1)`. Prior phase: 6 (round-2 finding #1 fix).
  // body_writer drains the in-process enqueue (every minute).
  {
    name: 'trace_body_writer',
    cron: '* * * * *',
    fn: runTraceBodyWriter,
    phase: 1,
  },
  // body_recoverer flips persisted/orphans pending envelopes (every 5 min).
  {
    name: 'trace_body_recoverer',
    cron: '*/5 * * * *',
    fn: runTraceBodyRecoverer,
    phase: 1,
  },
  // matview refresh — unified_trace_events (every 5 min, CONCURRENTLY).
  {
    name: 'trace_matview_refresh',
    cron: '*/5 * * * *',
    fn: runTraceMatviewRefresh,
    phase: 1,
  },
];

const tasks: ScheduledTask[] = [];

/**
 * Cron drain state — issue #512 §6.
 *
 * `stopWorkers()` used to be a synchronous `task.stop()` loop: it prevented
 * FUTURE ticks but returned immediately, so `gracefulShutdown()` went on to
 * close the Redis and Postgres pools underneath a cron run that was still
 * executing. A nightly backup, an outbox drain or a scheduling tick would then
 * die mid-write against a closed pool.
 *
 * We now track every in-flight run so the drain can await it within a deadline
 * and REPORT what did not finish, and we refuse to overlap a job with itself.
 */
const inflight = new Map<string, Promise<void>>();
let acceptingTicks = true;
/** Jobs whose gauges are already registered (bounded by JOBS.length). */
const gaugesRegistered = new Set<string>();
const lastSuccessAt = new Map<string, number>();
const lastFailureAt = new Map<string, number>();

function registerWorkerGauges(name: string): void {
  if (gaugesRegistered.has(name)) return;
  gaugesRegistered.add(name);
  setGaugeProvider(metricsInternal.key('maia_worker_active_jobs', { worker: name }), () =>
    inflight.has(name) ? 1 : 0,
  );
  setGaugeProvider(metricsInternal.key('maia_worker_last_success_timestamp', { worker: name }), () =>
    Math.floor((lastSuccessAt.get(name) ?? 0) / 1000),
  );
  setGaugeProvider(metricsInternal.key('maia_worker_last_failure_timestamp', { worker: name }), () =>
    Math.floor((lastFailureAt.get(name) ?? 0) / 1000),
  );
}

function runTick(job: Job): void {
  // No new work once the drain started (issue #512: "Nenhum novo side effect
  // começa após draining").
  if (!acceptingTicks) return;
  // Self-overlap guard: a job whose previous run is still active is SKIPPED,
  // not queued. Every long-running job here (outbox drain, playground drain,
  // objective execute) is already single-flight via a DB lease, so a skipped
  // tick is strictly better than two racing runs.
  if (inflight.has(job.name)) {
    incCounter('maia_worker_tick_skipped_total', { worker: job.name, reason: 'overlap' });
    logger.warn({ job: job.name }, 'worker.tick_skipped_overlap');
    return;
  }
  registerWorkerGauges(job.name);
  const p = job
    .fn()
    .then(() => {
      lastSuccessAt.set(job.name, Date.now());
    })
    .catch((err) => {
      lastFailureAt.set(job.name, Date.now());
      logger.error({ err, job: job.name }, 'worker.failed');
    })
    .finally(() => {
      inflight.delete(job.name);
    });
  inflight.set(job.name, p);
}

export function startWorkers(currentPhase: number = 1): void {
  acceptingTicks = true;
  for (const job of JOBS) {
    if (job.phase > currentPhase) continue;
    const t = cron.schedule(job.cron, () => runTick(job), { timezone: 'America/Sao_Paulo' });
    tasks.push(t);
    registerWorkerGauges(job.name);
    logger.info(
      { job: job.name, cron: job.cron, phase: job.phase },
      'worker.scheduled',
    );
  }
}

/** Names of cron jobs currently executing. */
export function activeWorkerJobs(): string[] {
  return [...inflight.keys()];
}

export type StopWorkersResult = {
  /** Jobs that were running when the drain started and finished in time. */
  drained: string[];
  /** Jobs still executing when the deadline expired — reported, never hidden. */
  pending: string[];
};

/**
 * Stop scheduling new ticks and await the runs already in flight.
 *
 * @param deadlineMs how long to wait for in-flight runs. On expiry the still
 *        active job names are RETURNED so the caller can log/audit them
 *        (issue #512: "Componentes não drenados aparecem no log/métrica
 *        final"; "informar job ativo no momento do shutdown").
 */
export async function stopWorkers(deadlineMs = 15_000): Promise<StopWorkersResult> {
  await haltWorkerScheduling();
  return drainWorkers(deadlineMs);
}

/**
 * Stop scheduling, WITHOUT waiting — issue #512 review round 1 (P1 on
 * `src/index.ts:260`). This belongs to the first atomic shutdown step,
 * alongside `pauseQueueWorkers()`: everything that could START new work is
 * silenced before anything begins to close.
 *
 * Idempotent.
 */
export async function haltWorkerScheduling(): Promise<void> {
  acceptingTicks = false;
  // node-cron v4 `stop()` returns `void | Promise<void>`; await both shapes so
  // the scheduler is really quiesced before we start counting the drain.
  await Promise.all(tasks.map(async (t) => t.stop()));
  tasks.length = 0;
}

/** Await the cron runs already in flight. See `stopWorkers` for the contract. */
export async function drainWorkers(deadlineMs = 15_000): Promise<StopWorkersResult> {
  const running = [...inflight.keys()];
  if (running.length === 0) return { drained: [], pending: [] };
  logger.info({ jobs: running, deadline_ms: deadlineMs }, 'worker.drain_started');

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      Promise.all([...inflight.values()]).then(() => 'drained' as const),
      deadline,
    ]);
    const pending = outcome === 'timeout' ? [...inflight.keys()] : [];
    const drained = running.filter((j) => !pending.includes(j));
    if (pending.length > 0) {
      logger.error({ jobs: pending, deadline_ms: deadlineMs }, 'worker.drain_deadline_exceeded');
    }
    return { drained, pending };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam — resets the drain bookkeeping between specs. */
export function _resetWorkerStateForTests(): void {
  acceptingTicks = true;
  inflight.clear();
  tasks.length = 0;
  gaugesRegistered.clear();
  lastSuccessAt.clear();
  lastFailureAt.clear();
}

/** Test seam — drives one tick through the guard without a cron schedule. */
export const _internal = { runTick };
