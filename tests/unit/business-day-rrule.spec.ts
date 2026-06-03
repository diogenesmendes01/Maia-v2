import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';

// Calendar v2 is always-on: isBusinessDayBR reads holidays from the DB via
// holidaysRepo. Mock it to return the national fixed/moving holidays so these
// computation tests stay deterministic without a real database. The runs
// below only depend on 1° de Maio (Labour Day) being a holiday + weekend
// logic, so returning the national set is sufficient.
const { findInRangeMock } = vi.hoisted(() => ({ findInRangeMock: vi.fn() }));

vi.mock('../../src/db/repositories/holidays-repo.js', () => ({
  holidaysRepo: { findInRange: findInRangeMock },
}));

import {
  parseRRule,
  usesBusinessDayExtension,
  computeNextWithBusinessDays,
} from '../../src/scheduling/business-day-rrule.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { _internal_cache } from '../../src/lib/holidays-cache.js';
import {
  NATIONAL_FIXED,
  nationalMovingHolidays,
} from '../../src/lib/national-holidays.js';

const TENANT_CTX = { tenant_id: 'tenant-a', agent_id: 'default' };

// Build the national holiday rows (fixed + moving) for a year in the
// {month, day, name, type} shape holidaysRepo.findInRange returns.
function nationalRowsFor(year: number) {
  const fixed = NATIONAL_FIXED.map((f) => ({
    month: f.month,
    day: f.day,
    name: f.name,
    type: 'national',
  }));
  const moving = nationalMovingHolidays(year).map((m) => ({
    month: m.date.getUTCMonth() + 1,
    day: m.date.getUTCDate(),
    name: m.name,
    type: 'national',
  }));
  return [...fixed, ...moving];
}

describe('parseRRule extension', () => {
  it('parses FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard');
    expect(rule.byNthWorkday).toBe(5);
    expect(rule.workdayKind).toBe('standard');
    expect(usesBusinessDayExtension(rule)).toBe(true);
  });

  it('parses FREQ=DAILY;BYWORKDAY=true', () => {
    const rule = parseRRule('FREQ=DAILY;BYWORKDAY=true');
    expect(rule.byWorkday).toBe(true);
    expect(usesBusinessDayExtension(rule)).toBe(true);
  });

  it('legacy FREQ=MONTHLY;BYMONTHDAY=15 não usa extensão', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(usesBusinessDayExtension(rule)).toBe(false);
  });

  it('rejects BYNTHWORKDAY=29', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=29')).toThrow(/BYNTHWORKDAY must be in/);
  });

  it('rejects BYNTHWORKDAY=0', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=0')).toThrow();
  });

  it('rejects BYNTHWORKDAY with FREQ=WEEKLY', () => {
    expect(() => parseRRule('FREQ=WEEKLY;BYNTHWORKDAY=2;BYDAY=MO')).toThrow(
      /only valid with FREQ=MONTHLY/,
    );
  });

  it('rejects BYWORKDAY with FREQ=MONTHLY', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYWORKDAY=true')).toThrow(/only valid with FREQ=DAILY/);
  });

  it('rejects WORKDAY_KIND inválido', () => {
    expect(() =>
      parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=foo'),
    ).toThrow(/standard\|clt/);
  });

  it('parses BYNTHWORKDAY=-1 (último DU)', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=-1');
    expect(rule.byNthWorkday).toBe(-1);
  });
});

/**
 * Codex review #105 round-2 (medium): BYWORKDAY must not skip a valid
 * same-day run. holidaysRepo is mocked to the national set so only national
 * fixed/moving holidays apply, keeping these runs deterministic.
 */
describe('computeNextWithBusinessDays — BYWORKDAY same-day (Codex #105 round-2 medium)', () => {
  const TZ = 'America/Sao_Paulo';

  beforeEach(() => {
    _internal_cache.clear();
    findInRangeMock.mockReset();
    findInRangeMock.mockImplementation(
      async (args: { start: Date }) => nationalRowsFor(args.start.getUTCFullYear()),
    );
  });
  afterEach(() => {
    _internal_cache.clear();
  });

  // 2026-05-19 is a Tuesday (not a national holiday) → business day.
  // 2026-05-23 is a Saturday → not a business day.
  // 2026-05-25 is the following Monday → business day.

  it('BYHOUR=9 on Tuesday 08:00 BR returns SAME DAY at 09:00 BR (not next business day)', async () => {
    // 08:00 BR (UTC-3) = 11:00 UTC on a Tuesday.
    const after = fromZonedTime(new Date(2026, 4, 19, 8, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9', after),
    );
    // Expected: same calendar day, 09:00 BR.
    const expected = fromZonedTime(new Date(2026, 4, 19, 9, 0, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('BYHOUR=9 on Tuesday 10:00 BR (already past 09:00) advances to NEXT business day at 09:00 BR', async () => {
    const after = fromZonedTime(new Date(2026, 4, 19, 10, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9', after),
    );
    // Wednesday 2026-05-20 09:00 BR.
    const expected = fromZonedTime(new Date(2026, 4, 20, 9, 0, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('BYHOUR=9 on Saturday 08:00 BR skips to following Monday 09:00 BR', async () => {
    const after = fromZonedTime(new Date(2026, 4, 23, 8, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9', after),
    );
    // Monday 2026-05-25 09:00 BR.
    const expected = fromZonedTime(new Date(2026, 4, 25, 9, 0, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('BYHOUR=9 BYMINUTE=30 on Tuesday 09:00 BR returns SAME DAY at 09:30 BR', async () => {
    // Exact same-day-future minute boundary.
    const after = fromZonedTime(new Date(2026, 4, 19, 9, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9;BYMINUTE=30', after),
    );
    const expected = fromZonedTime(new Date(2026, 4, 19, 9, 30, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('BYHOUR=9 on Sunday 08:00 BR skips to Monday 09:00 BR (not Sunday 09:00)', async () => {
    // 2026-05-24 is a Sunday.
    const after = fromZonedTime(new Date(2026, 4, 24, 8, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9', after),
    );
    const expected = fromZonedTime(new Date(2026, 4, 25, 9, 0, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('BYHOUR=9 on the morning of a national holiday (1° de Maio, Friday) skips to next business day', async () => {
    // 2026-05-01 is a Friday AND Labor Day (national holiday).
    // Next business day = Monday 2026-05-04.
    const after = fromZonedTime(new Date(2026, 4, 1, 8, 0, 0, 0), TZ);
    const next = await runWithTenantContext(TENANT_CTX, () =>
      computeNextWithBusinessDays('FREQ=DAILY;BYWORKDAY=true;BYHOUR=9', after),
    );
    const expected = fromZonedTime(new Date(2026, 4, 4, 9, 0, 0, 0), TZ);
    expect(next.getTime()).toBe(expected.getTime());
  });
});
