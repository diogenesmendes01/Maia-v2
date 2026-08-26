/**
 * Issue #525 / PR #541 review, finding 1 — the read gate as a primitive.
 *
 * The property that matters (one turn cannot take the whole pool) is proved
 * against a real pool with two concurrent turns in
 * `tests/integration/turn-context-pool-fairness.spec.ts`; a round-trip count of
 * an isolated turn proves nothing about contention, and neither would a unit
 * test that only counted calls.
 *
 * What belongs HERE is the semaphore's own contract, which the integration test
 * exercises but cannot pin precisely: FIFO order, the ceiling holding when N
 * tasks are created in a single tick (the loader's exact shape), and — the one
 * that would be silent in production — that a permit is released on the
 * rejection path. A gate that leaks a permit per failed read degrades to a
 * waterfall after a handful of errors and then deadlocks, long after the deploy
 * that caused it.
 */
import { describe, it, expect } from 'vitest';
import { createReadGate } from '../../src/agent/turn-context/concurrency.js';

/** A task that reports when it starts and blocks until it is told to finish. */
function controllable(): {
  run: () => Promise<string>;
  started: boolean;
  finish: (value?: string) => void;
  fail: (err: Error) => void;
} {
  let resolveFn!: (v: string) => void;
  let rejectFn!: (e: Error) => void;
  const settled = new Promise<string>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const handle = {
    started: false,
    run: async (): Promise<string> => {
      handle.started = true;
      return settled;
    },
    finish: (value = 'ok'): void => resolveFn(value),
    fail: (err: Error): void => rejectFn(err),
  };
  return handle;
}

/** Let every already-resolved microtask run. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('#541 finding 1 — createReadGate', () => {
  it('never lets more than `max` tasks run at once, even when all start in one tick', async () => {
    const gate = createReadGate(3);
    const tasks = Array.from({ length: 8 }, () => controllable());
    const all = tasks.map((t) => gate(t.run));

    await tick();
    expect(tasks.filter((t) => t.started)).toHaveLength(3);

    tasks[0]!.finish();
    await tick();
    expect(tasks.filter((t) => t.started)).toHaveLength(4);

    for (const t of tasks) t.finish();
    await expect(Promise.all(all)).resolves.toHaveLength(8);
  });

  it('admits waiters in FIFO order', async () => {
    // FIFO is not cosmetic: the loader enqueues the CRITICAL group first, so a
    // LIFO queue would let a late optional read jump the turn's critical path
    // and both slow the turn down and delay its failure signal.
    const gate = createReadGate(1);
    const order: number[] = [];
    const tasks = Array.from({ length: 4 }, (_, i) => {
      const c = controllable();
      return {
        ...c,
        run: async (): Promise<string> => {
          order.push(i);
          return c.run();
        },
      };
    });
    const all = tasks.map((t) => gate(t.run));

    for (const t of tasks) {
      await tick();
      t.finish();
    }
    await Promise.all(all);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('releases the permit when the task REJECTS', async () => {
    const gate = createReadGate(1);
    const boom = gate(() => Promise.reject(new Error('read exploded')));
    await expect(boom).rejects.toThrow('read exploded');

    // The next task must still be admitted. If `finally` ever stopped firing,
    // this would hang instead of failing — which is why it is asserted rather
    // than assumed.
    await expect(gate(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('propagates the rejection unchanged — it never swallows or wraps', async () => {
    // The loader's whole critical/optional contract rides on this: a critical
    // rejection must still reject `Promise.all`, and an optional one must reach
    // `optional()`'s catch as the SAME error so the degraded reason is honest.
    const gate = createReadGate(2);
    const original = new Error('original');
    await expect(gate(() => Promise.reject(original))).rejects.toBe(original);
  });

  it('keeps the pipeline saturated across a hand-off (no stutter)', async () => {
    // The permit is handed straight to the next waiter rather than decremented
    // and re-acquired, so concurrency does not dip to `max - 1` between tasks.
    const gate = createReadGate(2);
    const tasks = Array.from({ length: 4 }, () => controllable());
    const all = tasks.map((t) => gate(t.run));

    await tick();
    tasks[0]!.finish();
    await tick();

    // 1 and 2 running (0 done, 3 queued) — still two in flight, not one.
    expect(tasks[1]!.started && tasks[2]!.started).toBe(true);
    expect(tasks[3]!.started).toBe(false);

    for (const t of tasks) t.finish();
    await Promise.all(all);
  });

  it('rejects a nonsensical ceiling at construction rather than at 3am', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createReadGate(bad)).toThrow(RangeError);
    }
  });
});
