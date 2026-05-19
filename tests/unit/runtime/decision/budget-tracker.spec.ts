import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '@/runtime/decision/budget-tracker.ts';

function injectClock() {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    reset: () => {
      now = 0;
    },
    set: (v: number) => {
      now = v;
    },
  };
}

describe('P9b — BudgetTracker', () => {
  it('starts and ends a sub-budget, returns duration', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(400, c.clock);
    tracker.startSub('early_pep');
    c.advance(25);
    const duration = tracker.endSub('early_pep');
    expect(duration).toBe(25);
  });

  it('snapshot() returns durations for all subs', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(400, c.clock);
    tracker.startSub('early_pep');
    c.advance(20);
    tracker.endSub('early_pep');
    tracker.startSub('intent');
    c.advance(50);
    tracker.endSub('intent');
    tracker.startSub('skill');
    c.advance(30);
    tracker.endSub('skill');

    const snap = tracker.snapshot();
    expect(snap['early_pep']).toBe(20);
    expect(snap['intent']).toBe(50);
    expect(snap['skill']).toBe(30);
  });

  it('snapshot includes in-flight subs using current time', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(400, c.clock);
    tracker.startSub('early_pep');
    c.advance(15);
    // Did not call endSub
    const snap = tracker.snapshot();
    expect(snap['early_pep']).toBe(15);
  });

  it('remaining() reflects elapsed time', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(400, c.clock);
    c.advance(150);
    expect(tracker.remaining()).toBe(250);
  });

  it('remaining() clamps to 0 once budget exhausted', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(100, c.clock);
    c.advance(150);
    expect(tracker.remaining()).toBe(0);
  });

  it('exhausted() returns true when elapsed > totalBudgetMs', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(100, c.clock);
    c.advance(101);
    expect(tracker.exhausted()).toBe(true);
  });

  it('exhausted() is false when elapsed equals or under budget', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(100, c.clock);
    c.advance(100);
    expect(tracker.exhausted()).toBe(false);
  });

  it('throws if startSub called twice for the same name', () => {
    const tracker = new BudgetTracker(400);
    tracker.startSub('intent');
    expect(() => tracker.startSub('intent')).toThrow(/already started/);
  });

  it('throws if endSub called without startSub', () => {
    const tracker = new BudgetTracker(400);
    expect(() => tracker.endSub('intent')).toThrow(/not started/);
  });

  it('elapsed() returns total time since construction', () => {
    const c = injectClock();
    const tracker = new BudgetTracker(400, c.clock);
    c.advance(42);
    expect(tracker.elapsed()).toBe(42);
  });
});
