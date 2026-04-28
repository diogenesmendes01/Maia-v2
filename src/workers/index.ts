import cron from 'node-cron';
import { logger } from '@/lib/logger.js';
import { runHealthMonitor } from './health-monitor.js';
import { runPendingExpirer } from './pending-expirer.js';
import { runIdempotencyCleanup } from './idempotency-cleanup.js';
import { runAuditModeExpirer } from './audit-mode-expirer.js';
import { runInactivitySweep } from './inactivity-sweep.js';
import { runConversationSummarizer } from './conversation-summarizer.js';
import { runReflectionBatch } from './reflection-batch.js';
import { runMorningBriefing, runEveningBriefing, runWeeklyBriefing } from './briefings.js';
import { tickEngine } from '@/workflows/engine.js';

type Job = { name: string; cron: string; fn: () => Promise<void>; phase: number };

const JOBS: Job[] = [
  { name: 'health_monitor', cron: '*/1 * * * *', fn: runHealthMonitor, phase: 1 },
  { name: 'pending_expirer', cron: '*/1 * * * *', fn: runPendingExpirer, phase: 1 },
  { name: 'workflow_engine_tick', cron: '*/30 * * * * *', fn: async () => { await tickEngine(); }, phase: 1 },
  { name: 'audit_mode_expirer', cron: '*/15 * * * *', fn: runAuditModeExpirer, phase: 1 },
  { name: 'idempotency_cleanup', cron: '0 4 * * *', fn: runIdempotencyCleanup, phase: 1 },
  { name: 'inactivity_sweep', cron: '0 3 * * *', fn: runInactivitySweep, phase: 1 },
  { name: 'conversation_summarizer', cron: '0 2 * * *', fn: runConversationSummarizer, phase: 2 },
  { name: 'reflection_batch', cron: '0 2 * * *', fn: runReflectionBatch, phase: 2 },
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
