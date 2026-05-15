import cron from 'node-cron';
import { logger } from '@/lib/logger.js';
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
import { tickEngine } from '@/workflows/engine.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export type Job = { name: string; cron: string; fn: () => Promise<void>; phase: number };

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
  {
    name: 'workflow_engine_tick',
    cron: '*/30 * * * * *',
    fn: async () => {
      // P0: single-tenant default. P6 will fan-out per tenant.
      // tickEngine() acessa workflows/workflow_steps (tabelas tenant-aware).
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        await tickEngine();
      });
    },
    phase: 1,
  },
  { name: 'audit_mode_expirer', cron: '*/15 * * * *', fn: runAuditModeExpirer, phase: 1 },
  { name: 'idempotency_cleanup', cron: '0 4 * * *', fn: runIdempotencyCleanup, phase: 1 },
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
];

const tasks: cron.ScheduledTask[] = [];

export function startWorkers(currentPhase: number = 1): void {
  for (const job of JOBS) {
    if (job.phase > currentPhase) continue;
    const t = cron.schedule(
      job.cron,
      () => {
        job.fn().catch((err) => logger.error({ err, job: job.name }, 'worker.failed'));
      },
      { scheduled: true, timezone: 'America/Sao_Paulo' },
    );
    tasks.push(t);
    logger.info({ job: job.name, cron: job.cron, phase: job.phase }, 'worker.scheduled');
  }
}

export function stopWorkers(): void {
  for (const t of tasks) t.stop();
}
