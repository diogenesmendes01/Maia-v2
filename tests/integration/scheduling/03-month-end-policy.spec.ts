/**
 * Spec 18 §13 — Acceptance test for Requirement 3.
 *
 * For BYMONTHDAY=31, each of the four month_end_policy values must
 * produce the documented dates across months that lack day 31.
 */

import { describe, it, expect } from 'vitest';
import { computeNext } from '../../../src/scheduling/rrule.js';

const RULE = 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9';

describe('Requirement 3 — month_end_policy', () => {
  it('skip_invalid_month: skips Feb / Apr / Jun / Sep / Nov', () => {
    // Feb 2026
    expect(computeNext(RULE, new Date('2026-02-01T03:00:00Z'), 'skip_invalid_month').toISOString())
      .toBe('2026-03-31T12:00:00.000Z');
    // Apr 2026 (30 days)
    expect(computeNext(RULE, new Date('2026-04-01T03:00:00Z'), 'skip_invalid_month').toISOString())
      .toBe('2026-05-31T12:00:00.000Z');
    // Jun 2026 (30 days)
    expect(computeNext(RULE, new Date('2026-06-01T03:00:00Z'), 'skip_invalid_month').toISOString())
      .toBe('2026-07-31T12:00:00.000Z');
    // Sep 2026 (30 days)
    expect(computeNext(RULE, new Date('2026-09-01T03:00:00Z'), 'skip_invalid_month').toISOString())
      .toBe('2026-10-31T12:00:00.000Z');
    // Nov 2026 (30 days)
    expect(computeNext(RULE, new Date('2026-11-01T03:00:00Z'), 'skip_invalid_month').toISOString())
      .toBe('2026-12-31T12:00:00.000Z');
  });

  it('last_day_of_month: Feb 2026 → Feb 28; Feb 2028 leap → Feb 29; Apr → Apr 30', () => {
    expect(computeNext(RULE, new Date('2026-02-01T03:00:00Z'), 'last_day_of_month').toISOString())
      .toBe('2026-02-28T12:00:00.000Z');
    expect(computeNext(RULE, new Date('2028-02-01T03:00:00Z'), 'last_day_of_month').toISOString())
      .toBe('2028-02-29T12:00:00.000Z');
    expect(computeNext(RULE, new Date('2026-04-01T03:00:00Z'), 'last_day_of_month').toISOString())
      .toBe('2026-04-30T12:00:00.000Z');
  });

  it('nearest_next: Feb → Mar 1; Apr → May 1', () => {
    expect(computeNext(RULE, new Date('2026-02-01T03:00:00Z'), 'nearest_next').toISOString())
      .toBe('2026-03-01T12:00:00.000Z');
    expect(computeNext(RULE, new Date('2026-04-01T03:00:00Z'), 'nearest_next').toISOString())
      .toBe('2026-05-01T12:00:00.000Z');
  });

  it('nearest_previous: Feb 2026 → Feb 28; Feb 2028 leap → Feb 29; Apr → Apr 30', () => {
    expect(computeNext(RULE, new Date('2026-02-01T03:00:00Z'), 'nearest_previous').toISOString())
      .toBe('2026-02-28T12:00:00.000Z');
    expect(computeNext(RULE, new Date('2028-02-01T03:00:00Z'), 'nearest_previous').toISOString())
      .toBe('2028-02-29T12:00:00.000Z');
    expect(computeNext(RULE, new Date('2026-04-01T03:00:00Z'), 'nearest_previous').toISOString())
      .toBe('2026-04-30T12:00:00.000Z');
  });

  it('all four policies for the same after timestamp produce distinct, documented outcomes', () => {
    const after = new Date('2026-02-01T03:00:00Z');
    const skip = computeNext(RULE, after, 'skip_invalid_month').toISOString();
    const last = computeNext(RULE, after, 'last_day_of_month').toISOString();
    const prev = computeNext(RULE, after, 'nearest_previous').toISOString();
    const next = computeNext(RULE, after, 'nearest_next').toISOString();
    expect(skip).toBe('2026-03-31T12:00:00.000Z');
    expect(last).toBe('2026-02-28T12:00:00.000Z');
    expect(prev).toBe('2026-02-28T12:00:00.000Z');
    expect(next).toBe('2026-03-01T12:00:00.000Z');
  });
});
