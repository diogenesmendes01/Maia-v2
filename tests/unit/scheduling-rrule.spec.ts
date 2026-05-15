import { describe, it, expect } from 'vitest';
import { parseRRule, computeNext } from '../../src/scheduling/rrule.js';

describe('parseRRule', () => {
  it('parses MONTHLY with BYMONTHDAY and default 09:00', () => {
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=5')).toMatchObject({
      freq: 'MONTHLY',
      bymonthday: 5,
      byhour: 9,
      byminute: 0,
    });
  });

  it('parses DAILY with custom BYHOUR/BYMINUTE', () => {
    expect(parseRRule('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')).toMatchObject({
      freq: 'DAILY',
      byhour: 8,
      byminute: 30,
    });
  });

  it('parses WEEKLY with BYDAY list', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10');
    expect(r.freq).toBe('WEEKLY');
    expect(r.byday).toEqual([1, 3, 5]);
  });

  it('rejects unsupported FREQ', () => {
    expect(() => parseRRule('FREQ=YEARLY')).toThrow(/unsupported FREQ/);
  });

  it('rejects BYDAY with non-WEEKLY', () => {
    expect(() => parseRRule('FREQ=DAILY;BYDAY=MO')).toThrow(/BYDAY only valid/);
  });

  it('rejects BYMONTHDAY out of range', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=32')).toThrow(/BYMONTHDAY out of range/);
  });
});

describe('computeNext basics', () => {
  it('DAILY: same day if BYHOUR not yet passed', () => {
    const after = new Date('2026-05-11T06:00:00Z'); // 03:00 BRT
    expect(computeNext('FREQ=DAILY;BYHOUR=9', after).toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });

  it('DAILY: next day if BYHOUR already passed', () => {
    const after = new Date('2026-05-11T15:00:00Z'); // 12:00 BRT
    expect(computeNext('FREQ=DAILY;BYHOUR=9', after).toISOString()).toBe('2026-05-12T12:00:00.000Z');
  });

  it('strictly after: candidate equal to `after` rejected', () => {
    const after = new Date('2026-05-05T12:00:00.000Z'); // exactly 09:00 BRT
    expect(computeNext('FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9', after).toISOString()).toBe(
      '2026-06-05T12:00:00.000Z',
    );
  });

  it('WEEKLY BYDAY=MO: jumps to next Monday', () => {
    const after = new Date('2026-05-11T15:00:00Z'); // Mon 12:00 BRT
    expect(computeNext('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', after).toISOString()).toBe(
      '2026-05-18T13:00:00.000Z',
    );
  });
});

describe('computeNext month_end_policy — Requirement 3', () => {
  const ruleWith31 = 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9';

  it('skip_invalid_month: Feb → March 31', () => {
    const after = new Date('2026-02-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'skip_invalid_month').toISOString()).toBe(
      '2026-03-31T12:00:00.000Z',
    );
  });

  it('last_day_of_month: Feb 2026 → Feb 28', () => {
    const after = new Date('2026-02-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'last_day_of_month').toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    );
  });

  it('last_day_of_month: Feb 2028 (leap) → Feb 29', () => {
    const after = new Date('2028-02-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'last_day_of_month').toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
  });

  it('nearest_next: Feb → March 1', () => {
    const after = new Date('2026-02-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'nearest_next').toISOString()).toBe(
      '2026-03-01T12:00:00.000Z',
    );
  });

  it('nearest_previous: Feb 2026 → Feb 28 (same as last_day for BYMONTHDAY=31)', () => {
    const after = new Date('2026-02-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'nearest_previous').toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    );
  });

  it('April 2026 (30 days): BYMONTHDAY=31 with skip → May 31', () => {
    const after = new Date('2026-04-15T15:00:00Z');
    expect(computeNext(ruleWith31, after, 'skip_invalid_month').toISOString()).toBe(
      '2026-05-31T12:00:00.000Z',
    );
  });
});
