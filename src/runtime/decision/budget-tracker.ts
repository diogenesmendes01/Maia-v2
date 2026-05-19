/**
 * P9b — BudgetTracker.
 *
 * Spec §6.1: tracks per-step durations + remaining budget. Throws
 * `BudgetExhaustedError` only on explicit caller check; the tracker itself
 * is a passive timer (engine decides when to abort).
 *
 * Test injectable clock so timing assertions are deterministic.
 */
import type { SubBudgetName } from './types.js';

interface SubEntry {
  started: number;
  ended?: number;
}

export class BudgetTracker {
  private startedAt: number;
  private subs: Map<string, SubEntry> = new Map();

  constructor(
    private totalBudgetMs: number,
    private clock: () => number = () => Date.now(),
  ) {
    this.startedAt = clock();
  }

  /** Starts a named sub-budget. Throws if already started. */
  startSub(name: SubBudgetName): void {
    if (this.subs.has(name)) {
      throw new Error(`BudgetTracker: sub-budget '${name}' already started`);
    }
    this.subs.set(name, { started: this.clock() });
  }

  /** Ends a sub-budget and returns its duration in ms. Throws if not started. */
  endSub(name: SubBudgetName): number {
    const sub = this.subs.get(name);
    if (!sub) {
      throw new Error(`BudgetTracker: sub-budget '${name}' was not started`);
    }
    const now = this.clock();
    sub.ended = now;
    return now - sub.started;
  }

  /** Total budget remaining, in ms (clamped >= 0). */
  remaining(): number {
    return Math.max(0, this.totalBudgetMs - (this.clock() - this.startedAt));
  }

  /** True if elapsed > totalBudgetMs. */
  exhausted(): boolean {
    return this.clock() - this.startedAt > this.totalBudgetMs;
  }

  /** Snapshot of all sub-budgets (ended uses recorded duration, in-flight uses now). */
  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    const now = this.clock();
    for (const [name, sub] of this.subs.entries()) {
      result[name] = (sub.ended ?? now) - sub.started;
    }
    return result;
  }

  /** Elapsed total time since tracker started. */
  elapsed(): number {
    return this.clock() - this.startedAt;
  }
}
