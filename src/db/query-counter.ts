/**
 * Issue #511 — per-turn DB round-trip counter.
 *
 * The turn-context hot path (`agent/prompt-builder.ts` → `agent/turn-context/`)
 * was optimised without any number attached to it: nobody could say how many
 * round-trips a turn cost, so nobody could say whether a change made it worse.
 * This module is the measuring stick.
 *
 * Mechanics: an `AsyncLocalStorage` frame is opened by `runWithQueryCounter`
 * and every drizzle query increments it (`src/db/client.ts` wraps the pg client
 * passed to drizzle and calls `recordDbQuery()` per `client.query`). Because the
 * counter frames form a parent chain, a nested `runWithQueryCounter` (e.g. the
 * optional-context phase inside a whole-turn measurement) increments BOTH its
 * own frame and every enclosing frame — an inner measurement never hides work
 * from an outer one.
 *
 * Scope of what is counted:
 *   - every `db.*` query issued through the instrumented drizzle client,
 *     including `db.execute(sql\`…\`)`;
 *   - every query issued through the `tx` handle inside `withTx` (the
 *     transaction's PoolClient is instrumented the same way).
 *
 * NOT counted: raw `pool.query` / `pool.connect()` calls made outside drizzle
 * (the exported `pool` is deliberately left un-proxied so `pool.end()` and the
 * health probe keep their exact pg semantics). No repository goes through that
 * path, so the turn-context numbers are exact.
 *
 * Zero cost when no frame is open: `recordDbQuery()` is a single ALS read plus
 * a null check, so production traffic outside an instrumented turn pays nothing
 * measurable.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type CounterFrame = {
  count: number;
  parent: CounterFrame | null;
};

const storage = new AsyncLocalStorage<CounterFrame>();

/**
 * Live view of a counter frame. Readable while `fn` is still running (and from
 * a `finally` block after it threw) so callers can report the query count even
 * on the failure path.
 */
export type QueryCounter = {
  readonly count: number;
};

/**
 * Increment every open counter frame. Called once per drizzle query by the
 * instrumented client in `src/db/client.ts`. No-op when no frame is open.
 */
export function recordDbQuery(by = 1): void {
  let frame: CounterFrame | null = storage.getStore() ?? null;
  while (frame) {
    frame.count += by;
    frame = frame.parent;
  }
}

/**
 * Run `fn` with a fresh query-counter frame. The frame is handed to `fn` so the
 * count can be read after the fact — including from a `finally` when `fn`
 * rejects.
 */
export async function runWithQueryCounter<T>(
  fn: (counter: QueryCounter) => Promise<T>,
): Promise<T> {
  const frame: CounterFrame = { count: 0, parent: storage.getStore() ?? null };
  return storage.run(frame, () => fn(frame));
}

/**
 * Current innermost frame's count, or `null` when no frame is open. Useful for
 * assertions and for ad-hoc instrumentation that does not own the frame.
 */
export function currentQueryCount(): number | null {
  return storage.getStore()?.count ?? null;
}
