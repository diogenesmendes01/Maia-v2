import { describe, it, expect } from 'vitest';
import { parseRRule, computeNext } from '../../src/workflows/rrule.js';

// All timestamps in tests are explicit UTC. São Paulo is UTC-3 year-round
// (no DST since 2019), so 09:00 BRT = 12:00 UTC.

describe('parseRRule', () => {
  it('parses MONTHLY with BYMONTHDAY and default 09:00', () => {
    const r = parseRRule('FREQ=MONTHLY;BYMONTHDAY=5');
    expect(r).toMatchObject({ freq: 'MONTHLY', bymonthday: 5, byhour: 9, byminute: 0 });
  });

  it('parses DAILY with custom BYHOUR/BYMINUTE', () => {
    const r = parseRRule('FREQ=DAILY;BYHOUR=8;BYMINUTE=30');
    expect(r).toMatchObject({ freq: 'DAILY', byhour: 8, byminute: 30 });
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

  it('requires BYMONTHDAY for MONTHLY', () => {
    expect(() => parseRRule('FREQ=MONTHLY')).toThrow(/requires BYMONTHDAY/);
  });

  it('requires BYDAY for WEEKLY', () => {
    expect(() => parseRRule('FREQ=WEEKLY')).toThrow(/requires BYDAY/);
  });
});

describe('computeNext', () => {
  it('DAILY: same day if after BYHOUR has not passed yet', () => {
    // 2026-05-11 06:00 UTC = 03:00 BRT — before 09:00 BRT
    const after = new Date('2026-05-11T06:00:00Z');
    const next = computeNext('FREQ=DAILY;BYHOUR=9', after);
    expect(next.toISOString()).toBe('2026-05-11T12:00:00.000Z'); // 09:00 BRT same day
  });

  it('DAILY: next day if BYHOUR has already passed', () => {
    // 2026-05-11 15:00 UTC = 12:00 BRT — after 09:00 BRT
    const after = new Date('2026-05-11T15:00:00Z');
    const next = computeNext('FREQ=DAILY;BYHOUR=9', after);
    expect(next.toISOString()).toBe('2026-05-12T12:00:00.000Z');
  });

  it('MONTHLY BYMONTHDAY=5: skips to next month when day 5 already passed', () => {
    // 2026-05-10 (May 10) BRT → next is June 5 BRT
    const after = new Date('2026-05-10T15:00:00Z'); // 12:00 BRT
    const next = computeNext('FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9', after);
    expect(next.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  it('MONTHLY BYMONTHDAY=5: same month when day 5 still ahead', () => {
    const after = new Date('2026-05-03T15:00:00Z'); // 12:00 BRT May 3
    const next = computeNext('FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9', after);
    expect(next.toISOString()).toBe('2026-05-05T12:00:00.000Z');
  });

  it('MONTHLY BYMONTHDAY=31: skips Feb correctly to March 31', () => {
    // After Feb 15 2026 12:00 BRT → next fire is March 31
    const after = new Date('2026-02-15T15:00:00Z');
    const next = computeNext('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9', after);
    expect(next.toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('WEEKLY BYDAY=MO: next Monday', () => {
    // 2026-05-11 is a Monday. After noon BRT → next Mon is May 18.
    const after = new Date('2026-05-11T15:00:00Z'); // 12:00 BRT Mon
    const next = computeNext('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10', after);
    expect(next.toISOString()).toBe('2026-05-18T13:00:00.000Z'); // 10:00 BRT next Mon
  });

  it('strictly after: candidate equal to `after` rejected', () => {
    const after = new Date('2026-05-05T12:00:00.000Z'); // exactly 09:00 BRT
    const next = computeNext('FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9', after);
    // Must be strictly after — next month
    expect(next.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });
});
