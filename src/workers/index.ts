import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';
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

export type Job = {
  name: string;
  cron: string;
  fn: () => Promise<void>;
  phase: number;
  /** When set, job is only scheduled if the feature flag is true at startup. */
  featureFlag?: boolean;
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
  // Scheduling tables (series/occurrences/tasks/outbox_messages) ainda não
  // têm tenant_id em P0 — workers rodam fora de tenant context.
  { name: 'scheduling_tick', cron: '* * * * *', fn: runScheduling, phase: 1 },
  { name: 'outbox_drain', cron: '* * * * *', fn: runOutboxDrainWorker, phase: 1 },
  { name: 'series_next_scheduler', cron: '*/10 * * * *', fn: runSeriesNextSchedulerWorker, phase: 1 },
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
  // rows to deprecated). Worker is gated by FEATURE_KNOWLEDGE_STATE_MACHINE_V1
  // — when off it early-returns immediately, so leaving the cron entry on is
  // safe.
  { name: 'knowledge_state_promoter', cron: '0 * * * *', fn: runKnowledgeStatePromoter, phase: 2 },
  // P10b — runtime trace: 3 workers (body writer, body recoverer, matview refresh).
  // Registered at phase 1 so they are included in the production startup call
  // `startWorkers(1)`. Gated on FEATURE_RUNTIME_TRACE_V1 so they are a no-op
  // when the flag is off. Prior phase: 6 (round-2 finding #1 fix).
  // body_writer drains the in-process enqueue (every minute).
  {
    name: 'trace_body_writer',
    cron: '* * * * *',
    fn: runTraceBodyWriter,
    phase: 1,
    featureFlag: config.FEATURE_RUNTIME_TRACE_V1,
  },
  // body_recoverer flips persisted/orphans pending envelopes (every 5 min).
  {
    name: 'trace_body_recoverer',
    cron: '*/5 * * * *',
    fn: runTraceBodyRecoverer,
    phase: 1,
    featureFlag: config.FEATURE_RUNTIME_TRACE_V1,
  },
  // matview refresh — unified_trace_events (every 5 min, CONCURRENTLY).
  {
    name: 'trace_matview_refresh',
    cron: '*/5 * * * *',
    fn: runTraceMatviewRefresh,
    phase: 1,
    featureFlag: config.FEATURE_RUNTIME_TRACE_V1,
  },
];

const tasks: ScheduledTask[] = [];

export function startWorkers(currentPhase: number = 1): void {
  for (const job of JOBS) {
    if (job.phase > currentPhase) continue;
    // Skip feature-flagged jobs whose flag is off.
    if (job.featureFlag === false) continue;
    const t = cron.schedule(
      job.cron,
      () => {
        job.fn().catch((err) => logger.error({ err, job: job.name }, 'worker.failed'));
      },
      { timezone: 'America/Sao_Paulo' },
    );
    tasks.push(t);
    logger.info(
      { job: job.name, cron: job.cron, phase: job.phase, featureFlag: job.featureFlag },
      'worker.scheduled',
    );
  }
}

export function stopWorkers(): void {
  for (const t of tasks) t.stop();
}
