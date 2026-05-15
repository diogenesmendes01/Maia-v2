/**
 * Spec 18 — RRULE subset + month_end_policy.
 *
 * Minimal iCal RFC 5545 subset:
 *   FREQ=DAILY | WEEKLY | MONTHLY
 *   BYDAY=MO,TU,...           (weekly only)
 *   BYMONTHDAY=1..31           (monthly only)
 *   BYHOUR=0..23               (default 9)
 *   BYMINUTE=0..59             (default 0)
 *
 * All math anchored to America/Sao_Paulo (single-tenant, no DST since 2019).
 *
 * `month_end_policy` controls behaviour when BYMONTHDAY exceeds the target
 * month's day count (spec 18 §6.1):
 *   - skip_invalid_month  → skip the month entirely (Feb with BYMONTHDAY=31 → March 31)
 *   - last_day_of_month   → fire on the last day (Feb 28/29)
 *   - nearest_previous    → equivalent to last_day_of_month for end-of-month
 *   - nearest_next        → fire on day 1 of the next month
 */

import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { MonthEndPolicy } from './types.js';

const TZ = 'America/Sao_Paulo';

export type ParsedRRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  byday?: ReadonlyArray<0 | 1 | 2 | 3 | 4 | 5 | 6>;
  bymonthday?: number;
  byhour: number;
  byminute: number;
};

const DAY_MAP: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export function parseRRule(s: string): ParsedRRule {
  const parts = s
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || v === undefined) throw new Error(`rrule: malformed segment "${p}"`);
    kv[k.toUpperCase()] = v;
  }
  const freqRaw = kv['FREQ'];
  if (freqRaw !== 'DAILY' && freqRaw !== 'WEEKLY' && freqRaw !== 'MONTHLY') {
    throw new Error(`rrule: unsupported FREQ "${freqRaw ?? '(missing)'}"`);
  }
  const byhour = kv['BYHOUR'] !== undefined ? parseInt(kv['BYHOUR'], 10) : 9;
  if (!Number.isInteger(byhour) || byhour < 0 || byhour > 23) {
    throw new Error(`rrule: BYHOUR out of range`);
  }
  const byminute = kv['BYMINUTE'] !== undefined ? parseInt(kv['BYMINUTE'], 10) : 0;
  if (!Number.isInteger(byminute) || byminute < 0 || byminute > 59) {
    throw new Error(`rrule: BYMINUTE out of range`);
  }
  const parsed: ParsedRRule = { freq: freqRaw, byhour, byminute };

  if (kv['BYDAY']) {
    if (freqRaw !== 'WEEKLY') throw new Error(`rrule: BYDAY only valid with FREQ=WEEKLY`);
    const days = kv['BYDAY']
      .split(',')
      .map((d) => d.trim().toUpperCase())
      .map((d) => {
        const n = DAY_MAP[d];
        if (n === undefined) throw new Error(`rrule: unknown BYDAY "${d}"`);
        return n;
      });
    return { ...parsed, byday: days };
  }

  if (kv['BYMONTHDAY']) {
    if (freqRaw !== 'MONTHLY') throw new Error(`rrule: BYMONTHDAY only valid with FREQ=MONTHLY`);
    const n = parseInt(kv['BYMONTHDAY'], 10);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error(`rrule: BYMONTHDAY out of range`);
    return { ...parsed, bymonthday: n };
  }

  if (freqRaw === 'WEEKLY') throw new Error(`rrule: FREQ=WEEKLY requires BYDAY`);
  if (freqRaw === 'MONTHLY') throw new Error(`rrule: FREQ=MONTHLY requires BYMONTHDAY`);
  return parsed;
}

function daysInMonth(year: number, monthZeroIndexed: number): number {
  return new Date(year, monthZeroIndexed + 1, 0).getDate();
}

/**
 * Apply month_end_policy to a candidate (year, month, requested day).
 * Returns the effective day to use, or null if the policy says "skip
 * this month, try the next one".
 */
function applyMonthEndPolicy(
  year: number,
  monthZeroIndexed: number,
  requestedDay: number,
  policy: MonthEndPolicy,
): { day: number; advanceMonth: boolean } | null {
  const dim = daysInMonth(year, monthZeroIndexed);
  if (requestedDay <= dim) return { day: requestedDay, advanceMonth: false };

  switch (policy) {
    case 'skip_invalid_month':
      return null;
    case 'last_day_of_month':
    case 'nearest_previous':
      return { day: dim, advanceMonth: false };
    case 'nearest_next':
      return { day: 1, advanceMonth: true };
  }
}

export function computeNext(
  rule: ParsedRRule | string,
  after: Date,
  policy: MonthEndPolicy = 'skip_invalid_month',
): Date {
  const r = typeof rule === 'string' ? parseRRule(rule) : rule;
  const MAX_DAYS = 366 * 2; // extra slack so policies can probe ahead

  // For MONTHLY with BYMONTHDAY, we iterate by month rather than by day —
  // otherwise `BYMONTHDAY=31` with `skip_invalid_month` would scan ~30 days
  // of misses each time.
  if (r.freq === 'MONTHLY' && r.bymonthday !== undefined) {
    const startZ = toZonedTime(after, TZ);
    for (let m = 0; m < 24; m++) {
      const probe = new Date(startZ);
      probe.setDate(1);
      probe.setMonth(probe.getMonth() + m);
      const resolved = applyMonthEndPolicy(
        probe.getFullYear(),
        probe.getMonth(),
        r.bymonthday,
        policy,
      );
      if (!resolved) continue;
      const target = new Date(probe);
      if (resolved.advanceMonth) {
        target.setMonth(target.getMonth() + 1);
        target.setDate(resolved.day);
      } else {
        target.setDate(resolved.day);
      }
      target.setHours(r.byhour, r.byminute, 0, 0);
      const candidate = fromZonedTime(target, TZ);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    throw new Error(`rrule: no MONTHLY match within 24 months`);
  }

  // DAILY / WEEKLY: scan day-by-day.
  const startZ = toZonedTime(after, TZ);
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const dz = new Date(startZ);
    dz.setDate(dz.getDate() + offset);
    dz.setHours(r.byhour, r.byminute, 0, 0);
    const dow = dz.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    let matches = false;
    if (r.freq === 'DAILY') matches = true;
    else if (r.freq === 'WEEKLY') matches = (r.byday ?? []).includes(dow);
    if (!matches) continue;
    const candidate = fromZonedTime(dz, TZ);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`rrule: no match within ${MAX_DAYS} days`);
}
