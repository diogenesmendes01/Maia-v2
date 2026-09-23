/** Explicit backend-only, async-scoped composition. No env/global live activation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { createJournaledHermesRuntime } from './hermes-runtime.js';
export type SyntheticCoreRuntime = ReturnType<typeof createJournaledHermesRuntime> & {
  hermesSha: string;
};
const context = new AsyncLocalStorage<SyntheticCoreRuntime>();
export const getSyntheticCoreRuntime = () => context.getStore();
export function withSyntheticCoreRuntime<T>(
  runtime: SyntheticCoreRuntime,
  fn: () => Promise<T>,
): Promise<T> {
  return context.run(runtime, fn);
}
