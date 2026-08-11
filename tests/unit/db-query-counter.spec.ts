import { describe, it, expect } from 'vitest';
import {
  recordDbQuery,
  runWithQueryCounter,
  currentQueryCount,
} from '../../src/db/query-counter.js';

/**
 * Issue #511 — the measuring stick itself.
 *
 * `runWithQueryCounter` is what turns "the prompt build got slower" into a
 * number, so its own semantics need to hold under the two conditions the turn
 * path actually creates: concurrent turns (ALS isolation) and nested phases
 * (the optional-context load measured inside a whole-turn measurement).
 */
describe('#511 db query counter', () => {
  it('counts queries recorded inside the frame', async () => {
    const n = await runWithQueryCounter(async (counter) => {
      recordDbQuery();
      recordDbQuery();
      recordDbQuery();
      return counter.count;
    });
    expect(n).toBe(3);
  });

  it('is a no-op outside any frame', () => {
    expect(currentQueryCount()).toBeNull();
    // Must not throw — most of the process runs outside an instrumented turn.
    expect(() => recordDbQuery()).not.toThrow();
  });

  it('reports the count even when the body throws', async () => {
    let observed = -1;
    await expect(
      runWithQueryCounter(async (counter) => {
        recordDbQuery();
        recordDbQuery();
        try {
          throw new Error('boom');
        } finally {
          observed = counter.count;
        }
      }),
    ).rejects.toThrow('boom');
    expect(observed).toBe(2);
  });

  it('propagates nested counts to the enclosing frame', async () => {
    const { outer, inner } = await runWithQueryCounter(async (outerCounter) => {
      recordDbQuery(); // outer only
      const innerCount = await runWithQueryCounter(async (innerCounter) => {
        recordDbQuery();
        recordDbQuery();
        return innerCounter.count;
      });
      return { outer: outerCounter.count, inner: innerCount };
    });
    // An inner phase must never hide its cost from the whole-turn total.
    expect(inner).toBe(2);
    expect(outer).toBe(3);
  });

  it('isolates concurrent frames', async () => {
    const [a, b] = await Promise.all([
      runWithQueryCounter(async (counter) => {
        recordDbQuery();
        await new Promise((r) => setTimeout(r, 5));
        recordDbQuery();
        return counter.count;
      }),
      runWithQueryCounter(async (counter) => {
        recordDbQuery();
        return counter.count;
      }),
    ]);
    expect(a).toBe(2);
    expect(b).toBe(1);
  });
});
