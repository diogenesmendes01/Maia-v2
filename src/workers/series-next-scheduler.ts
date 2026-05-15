import { runSeriesNextScheduler } from '@/scheduling/engine.js';

export async function runSeriesNextSchedulerWorker(): Promise<void> {
  await runSeriesNextScheduler();
}
