/**
 * Business-day calendar API — async, tenant-aware, FEATURE_CALENDAR_V2-gated.
 *
 * Flag OFF (default): fast-path legacy — apenas nacionais hard-coded (mantém
 * comportamento pré-PR; rollback instantâneo via flag flip).
 *
 * Flag ON: lookup completo via holidaysRepo, com cache LRU tenant-aware.
 *
 * kind:
 *   - standard: sáb/dom não-úteis (negócios em geral, agendamentos B2B)
 *   - clt: sábado é útil (jurídico CLT, ex.: prazos trabalhistas)
 */
import { featureFlags } from '../config/feature-flags.js';
import { FeatureFlagName } from '../types/enums.js';
import { getApplicableHolidaysSet, type BusinessDayKind } from './holidays-cache.js';
import { nationalMovingHolidays, NATIONAL_FIXED } from './national-holidays.js';
import { holidaysRepo } from '../db/repositories/holidays-repo.js';

export type { BusinessDayKind };

export interface BusinessDayOptions {
  kind?: BusinessDayKind;
  entidadeId?: string;
  tz?: string;
}

/**
 * Legacy fallback — hard-coded apenas nacionais. Mantém o comportamento
 * pré-PR quando flag OFF (rollback instantâneo).
 */
function isBusinessDayBR_legacy(date: Date): boolean {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  for (const f of NATIONAL_FIXED) {
    if (f.month === month && f.day === day) return false;
  }
  for (const m of nationalMovingHolidays(year)) {
    if (m.date.getUTCMonth() + 1 === month && m.date.getUTCDate() === day) return false;
  }
  return true;
}

export async function isBusinessDayBR(
  date: Date,
  options?: BusinessDayOptions,
): Promise<boolean> {
  if (!featureFlags.isEnabled(FeatureFlagName.CALENDAR_V2)) {
    return isBusinessDayBR_legacy(date);
  }

  const kind: BusinessDayKind = options?.kind ?? 'standard';
  const dow = date.getUTCDay();
  if (dow === 0) return false;
  if (kind === 'standard' && dow === 6) return false;

  const year = date.getUTCFullYear();
  const cached = await getApplicableHolidaysSet(year, options ?? {}, async (_tenant_id) => {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31));
    const rows = await holidaysRepo.findInRange({
      entidadeId: options?.entidadeId,
      start,
      end,
    });
    return new Set(
      rows.map(
        (r) =>
          `${year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`,
      ),
    );
  });

  const iso = date.toISOString().slice(0, 10);
  return !cached.has(iso);
}

/**
 * Próximo dia útil estritamente após a data dada (limite de segurança: 365 iter).
 */
export async function nextBusinessDayBR(
  date: Date,
  options?: BusinessDayOptions,
): Promise<Date> {
  let d = new Date(date.getTime());
  for (let i = 0; i < 365; i++) {
    d = new Date(d.getTime() + 86_400_000);
    if (await isBusinessDayBR(d, options)) return d;
  }
  throw new Error('nextBusinessDayBR: no business day found within 365 days');
}

export async function previousBusinessDayBR(
  date: Date,
  options?: BusinessDayOptions,
): Promise<Date> {
  let d = new Date(date.getTime());
  for (let i = 0; i < 365; i++) {
    d = new Date(d.getTime() - 86_400_000);
    if (await isBusinessDayBR(d, options)) return d;
  }
  throw new Error('previousBusinessDayBR: no business day found within 365 days');
}

export async function addBusinessDays(
  date: Date,
  count: number,
  options?: BusinessDayOptions,
): Promise<Date> {
  if (count === 0) return date;
  let d = new Date(date.getTime());
  const step = count > 0 ? 86_400_000 : -86_400_000;
  let remaining = Math.abs(count);
  for (let i = 0; i < 365 * 4 && remaining > 0; i++) {
    d = new Date(d.getTime() + step);
    if (await isBusinessDayBR(d, options)) remaining--;
  }
  if (remaining > 0) throw new Error('addBusinessDays: exhausted iteration budget');
  return d;
}

/**
 * N-ésimo dia útil do mês (1..28 ou -1 para "último"). kind opcional.
 */
export async function getNthBusinessDayOfMonth(
  year: number,
  monthZeroIndexed: number,
  n: number,
  options?: BusinessDayOptions,
): Promise<Date> {
  if (n !== -1 && (n < 1 || n > 28)) {
    throw new Error(`n must be in [1..28] or -1; got ${n}`);
  }
  const lastDay = new Date(Date.UTC(year, monthZeroIndexed + 1, 0)).getUTCDate();

  if (n === -1) {
    // varredura reversa
    for (let day = lastDay; day >= 1; day--) {
      const d = new Date(Date.UTC(year, monthZeroIndexed, day));
      if (await isBusinessDayBR(d, options)) return d;
    }
    throw new Error('getNthBusinessDayOfMonth: nenhum dia útil encontrado');
  }

  let count = 0;
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(Date.UTC(year, monthZeroIndexed, day));
    if (await isBusinessDayBR(d, options)) {
      count++;
      if (count === n) return d;
    }
  }
  throw new Error(
    `getNthBusinessDayOfMonth: month ${year}-${monthZeroIndexed + 1} has only ${count} business days (requested ${n})`,
  );
}

export interface HolidayInRange {
  date: Date;
  name: string;
  type: string;
}

export async function getHolidaysInRange(args: {
  start: Date;
  end: Date;
  entidadeId?: string;
}): Promise<HolidayInRange[]> {
  if (!featureFlags.isEnabled(FeatureFlagName.CALENDAR_V2)) {
    // fallback legacy: apenas nacionais (fixos + móveis) do(s) ano(s) no range.
    const out: HolidayInRange[] = [];
    const startYear = args.start.getUTCFullYear();
    const endYear = args.end.getUTCFullYear();
    for (let y = startYear; y <= endYear; y++) {
      for (const f of NATIONAL_FIXED) {
        const d = new Date(Date.UTC(y, f.month - 1, f.day));
        if (d >= args.start && d <= args.end) {
          out.push({ date: d, name: f.name, type: 'national' });
        }
      }
      for (const m of nationalMovingHolidays(y)) {
        if (m.date >= args.start && m.date <= args.end) {
          out.push({ date: m.date, name: m.name, type: 'national' });
        }
      }
    }
    out.sort((a, b) => a.date.getTime() - b.date.getTime());
    return out;
  }

  // Flag ON: usa holidaysRepo
  const startYear = args.start.getUTCFullYear();
  const endYear = args.end.getUTCFullYear();
  const out: HolidayInRange[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const yearStart = new Date(Date.UTC(y, 0, 1));
    const yearEnd = new Date(Date.UTC(y, 11, 31));
    const rows = await holidaysRepo.findInRange({
      entidadeId: args.entidadeId,
      start: yearStart,
      end: yearEnd,
    });
    for (const r of rows) {
      const d = new Date(Date.UTC(y, r.month - 1, r.day));
      if (d >= args.start && d <= args.end) {
        out.push({ date: d, name: r.name, type: r.type });
      }
    }
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

export async function getNextHoliday(args: {
  from: Date;
  entidadeId?: string;
}): Promise<HolidayInRange | null> {
  const horizonEnd = new Date(args.from.getTime() + 366 * 86_400_000);
  const all = await getHolidaysInRange({ start: args.from, end: horizonEnd, entidadeId: args.entidadeId });
  return all[0] ?? null;
}
