import { runOutboxDrain } from '@/scheduling/outbox-drain.js';

export async function runOutboxDrainWorker(): Promise<void> {
  await runOutboxDrain();
}
