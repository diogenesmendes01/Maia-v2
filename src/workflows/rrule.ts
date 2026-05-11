/**
 * Minimal subset of iCal RRULE (RFC 5545) for Maia's recurring scheduling.
 *
 * Supported components:
 *   FREQ=DAILY | WEEKLY | MONTHLY
 *   BYDAY=MO,TU,WE,TH,FR,SA,SU   (weekly only)
 *   BYMONTHDAY=1..31              (monthly only)
 *   BYHOUR=0..23                   (default 9)
 *   BYMINUTE=0..59                 (default 0)
 *
 * All computations honour `America/Sao_Paulo` (single-tenant assumption,
 * see spec 00). `date-fns-tz` is already a dependency.
 *
 * `computeNext(rule, after)` returns the next fire timestamp strictly after
 * `after`. Throws if no match within 366 days (guards against malformed
 * input like `BYMONTHDAY=31;FREQ=MONTHLY` always-Feb).
 */

import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const TZ = 'America/Sao_Paulo';

export type ParsedRRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  byday?: ReadonlyArray<0 | 1 | 2 | 3 | 4 | 5 | 6>; // 0=Sun ... 6=Sat
  bymonthday?: number; // 1..31
  byhour: number; // 0..23
  byminute: number; // 0..59
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

/**
 * Returns the next firing timestamp strictly after `after`, anchored to the
 * São Paulo timezone, as a UTC Date. Throws if no match within 366 days.
 */
export function computeNext(rule: ParsedRRule | string, after: Date): Date {
  const r = typeof rule === 'string' ? parseRRule(rule) : rule;
  const MAX_DAYS = 366;
  const startZ = toZonedTime(after, TZ);
  // Begin scanning at the day of `after`. We accept "today" only if the
  // resulting candidate ends up strictly after `after`.
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const dz = new Date(startZ);
    dz.setDate(dz.getDate() + offset);
    dz.setHours(r.byhour, r.byminute, 0, 0);

    const dom = dz.getDate();
    const dow = dz.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;

    let matches = false;
    if (r.freq === 'DAILY') {
      matches = true;
    } else if (r.freq === 'WEEKLY') {
      matches = (r.byday ?? []).includes(dow);
    } else if (r.freq === 'MONTHLY') {
      matches = dom === r.bymonthday;
    }
    if (!matches) continue;

    const candidate = fromZonedTime(dz, TZ);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`rrule: no match within ${MAX_DAYS} days`);
}
