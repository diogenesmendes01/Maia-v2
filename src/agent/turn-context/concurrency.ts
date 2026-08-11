/**
 * Issue #525 (PR #541 review, finding 1) — the turn's SHARED read gate.
 *
 * ## The hole this closes
 *
 * Before #525, the turn's concurrent reads were the six optional sections under
 * one `Promise.allSettled`, and the comment that shipped with them said out
 * loud why six: "six concurrent reads against a 10-connection pool
 * (`src/db/client.ts`) is a deliberate ceiling — enough to collapse the
 * waterfall, not enough for one turn to starve the pool for everyone else."
 *
 * #525 split the read set into a critical group (5) and an optional group (5)
 * and started the second BEFORE awaiting the first, which is exactly the right
 * latency move — but it deleted the ceiling without replacing it. Ten reads
 * issued in the same tick against `max: 10` means ONE turn can hold every
 * connection in the process-wide pool. The turn that wins the race gets its
 * latency win; every other turn, of every other tenant, pays for it in queueing
 * and p95 tail. Two simultaneous turns already contend for a capacity the first
 * one can occupy entirely.
 *
 * ## Why a gate and not a phase split
 *
 * Running the groups in sequence (critical, then optional) would cap
 * concurrency at 5 but reintroduce half the waterfall #525 removed: the turn
 * would pay `max(critical) + max(optional)` instead of `max(everything)`. A
 * shared FIFO semaphore keeps ALL ten tasks in one pipeline and only bounds how
 * many are in flight at once, so the turn still pays roughly the maximum, not
 * the sum — while the pool sees at most `max` of this turn's statements.
 *
 * ## Why FIFO matters
 *
 * The critical tasks are enqueued first, so they hold the first permits and the
 * optional ones fill the remainder and then drain in order. A LIFO or unordered
 * queue would let a late optional read jump ahead of a critical one and push the
 * turn's own critical path out — the turn would be slower AND the failure
 * signature (a critical rejection) would arrive later.
 *
 * ## What the gate deliberately does NOT do
 *
 *  - It does not catch. A rejection propagates exactly as it would without the
 *    gate, so the loader's contract is untouched: a critical rejection still
 *    fails the turn, and an optional rejection is still caught by `optional()`
 *    one frame up and degrades only its own section.
 *  - It does not retry, time out, or reorder results. Callers collect results
 *    positionally through `Promise.all`.
 *  - It is per-turn, not per-process. A process-wide gate would make one
 *    tenant's slow turn block another tenant's fast one INSIDE the application,
 *    which is a worse failure than letting the pool queue do it: the pool at
 *    least has `connectionTimeoutMillis`. Per-turn bounds the blast radius of a
 *    single turn, which is what the finding is about.
 */

/**
 * Run `fn` under a permit, releasing it when `fn` settles.
 *
 * Sharing one `ReadGate` across several call sites is what makes the ceiling a
 * property of the TURN rather than of one group inside it.
 */
export type ReadGate = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A FIFO counting semaphore rendered as a one-function API.
 *
 * `max <= 0` is rejected rather than silently treated as "unlimited": a gate
 * that lets everything through is the bug this module exists to prevent, and a
 * misconfigured constant should fail loudly at construction, not quietly at 3am
 * under load.
 */
export function createReadGate(max: number): ReadGate {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createReadGate: max must be a positive integer, got ${String(max)}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < max) {
      // Incremented SYNCHRONOUSLY, before the caller gets a chance to await.
      // That is what makes the ceiling hold when N tasks are created in a
      // single tick — the shape of the loader's two `Promise.all` groups.
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    // Hand the permit straight to the next waiter instead of decrementing and
    // letting it re-acquire: `active` never dips, so the gate stays saturated
    // and the pipeline does not stutter between tasks.
    if (next) next();
    else active--;
  }

  return async function runGated<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
