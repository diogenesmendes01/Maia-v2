import { describe, it, expect, vi } from 'vitest';

// Minimal mocks: workers/index.ts pulls a wide tree of job functions, and
// each of those in turn imports config/redis/db. Stub everything to a
// no-op resolved promise — the registry test only cares about the JOBS
// array shape, not the underlying behaviour.
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const noopAsync = vi.fn(async () => undefined);
const noopWorkers = {
  runHealthMonitor: noopAsync,
  runPendingExpirer: noopAsync,
  runIdempotencyCleanup: noopAsync,
  runAuditModeExpirer: noopAsync,
  runInactivitySweep: noopAsync,
  runConversationSummarizer: noopAsync,
  runReflectionBatch: noopAsync,
  runMessageRecovery: noopAsync,
  runPendingReminder: noopAsync,
  runNightlyBackup: noopAsync,
  runCloudBackupRotation: noopAsync,
  runCostMonitor: noopAsync,
  runAuditWatcher: noopAsync,
  runDlqMonitor: noopAsync,
  runMorningBriefing: noopAsync,
  runEveningBriefing: noopAsync,
  runWeeklyBriefing: noopAsync,
};

vi.mock('../../src/workers/health-monitor.js', () => noopWorkers);
vi.mock('../../src/workers/pending-expirer.js', () => noopWorkers);
vi.mock('../../src/workers/idempotency-cleanup.js', () => noopWorkers);
vi.mock('../../src/workers/audit-mode-expirer.js', () => noopWorkers);
vi.mock('../../src/workers/inactivity-sweep.js', () => noopWorkers);
vi.mock('../../src/workers/conversation-summarizer.js', () => noopWorkers);
vi.mock('../../src/workers/reflection-batch.js', () => noopWorkers);
vi.mock('../../src/workers/message-recovery.js', () => noopWorkers);
vi.mock('../../src/workers/pending-reminder.js', () => noopWorkers);
vi.mock('../../src/workers/backup.js', () => ({
  runNightlyBackup: noopAsync,
  runCloudBackupRotation: noopAsync,
}));
vi.mock('../../src/workers/cost-monitor.js', () => noopWorkers);
vi.mock('../../src/workers/audit-watcher.js', () => noopWorkers);
vi.mock('../../src/workers/dlq-monitor.js', () => noopWorkers);
vi.mock('../../src/workers/briefings.js', () => noopWorkers);
vi.mock('../../src/workflows/engine.js', () => ({ tickEngine: noopAsync }));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
}));

describe('workers registry', () => {
  it('registers cloud_backup_rotation as a weekly Sunday 04:00 phase-1 job', async () => {
    const { JOBS } = await import('../../src/workers/index.js');
    const job = JOBS.find((j) => j.name === 'cloud_backup_rotation');
    expect(job).toBeDefined();
    // Sundays at 04:00 in America/Sao_Paulo
    expect(job!.cron).toBe('0 4 * * 0');
    expect(job!.phase).toBe(1);
  });

  it('also keeps nightly_backup on its existing schedule (no regression)', async () => {
    const { JOBS } = await import('../../src/workers/index.js');
    const job = JOBS.find((j) => j.name === 'nightly_backup');
    expect(job).toBeDefined();
    expect(job!.cron).toBe('0 3 * * *');
    expect(job!.phase).toBe(1);
  });
});
