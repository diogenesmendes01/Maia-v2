/**
 * Smoke tests para as 5 tools calendar_* (read-only). Foco no contrato de
 * input/output. Lógica end-to-end vive em business-days.spec.ts e demais.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

import { calendarIsBusinessDayTool } from '@/tools/calendar/calendar-is-business-day.js';
import { calendarNextHolidayTool } from '@/tools/calendar/calendar-next-holiday.js';
import { calendarListHolidaysTool } from '@/tools/calendar/calendar-list-holidays.js';
import { calendarBusinessDaysBetweenTool } from '@/tools/calendar/calendar-business-days-between.js';
import { calendarAddBusinessDaysTool } from '@/tools/calendar/calendar-add-business-days.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const dummyCtx = {} as never;

describe('calendar_* tools — contracts', () => {
  beforeEach(() => featureFlags.killSwitch(FeatureFlagName.CALENDAR_V2));
  afterEach(() => featureFlags.reset());

  it('calendar_is_business_day — flag OFF retorna fallback legacy', async () => {
    const out = await calendarIsBusinessDayTool.handler(
      { date: '2026-06-04', kind: 'standard' },
      dummyCtx,
    );
    expect(out.is_business_day).toBe(false); // Corpus Christi
    expect(out.calendar_v2_enabled).toBe(false);
  });

  it('calendar_next_holiday — flag OFF retorna feriado nacional (fallback)', async () => {
    const out = await calendarNextHolidayTool.handler(
      { from: '2026-06-01' },
      dummyCtx,
    );
    expect(out.holiday).not.toBeNull();
    expect(out.holiday!.date).toBe('2026-06-04'); // Corpus Christi
  });

  it('calendar_list_holidays — flag OFF lista nacionais no range', async () => {
    const out = await calendarListHolidaysTool.handler(
      { start: '2026-12-01', end: '2026-12-31' },
      dummyCtx,
    );
    expect(out.holidays.map((h) => h.date)).toContain('2026-12-25');
  });

  it('calendar_business_days_between — flag OFF conta dias úteis 01-08/jun/2026', async () => {
    const out = await calendarBusinessDaysBetweenTool.handler(
      { start: '2026-06-01', end: '2026-06-08' },
      dummyCtx,
    );
    // 01-seg, 02-ter, 03-qua, 04-corpus(feriado), 05-sex, 06-sab, 07-dom, 08-seg = 5 dias úteis
    expect(out.total_days).toBe(8);
    expect(out.business_days).toBe(5);
  });

  it('calendar_add_business_days — flag OFF respeita feriados nacionais', async () => {
    const out = await calendarAddBusinessDaysTool.handler(
      { date: '2026-06-01', count: 5 },
      dummyCtx,
    );
    // start 01 (seg) NÃO conta. +1=02, +2=03, +3=05 (pula 04 corpus & 06/07 fds), +4=08, +5=09
    expect(out.result_date).toBe('2026-06-09');
  });

  it('calendar_add_business_days — rejeita count fora dos limites', async () => {
    await expect(
      calendarAddBusinessDaysTool.handler({ date: '2026-06-01', count: 10000 }, dummyCtx),
    ).rejects.toThrow(/out of bounds/);
  });

  it('calendar_business_days_between — rejeita range > 366 dias', async () => {
    await expect(
      calendarBusinessDaysBetweenTool.handler(
        { start: '2025-01-01', end: '2026-06-01' },
        dummyCtx,
      ),
    ).rejects.toThrow(/range > 366/);
  });
});
