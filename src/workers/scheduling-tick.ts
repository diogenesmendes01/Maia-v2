import { runSchedulingTick } from '@/scheduling/engine.js';

export async function runScheduling(): Promise<void> {
  await runSchedulingTick();
}
