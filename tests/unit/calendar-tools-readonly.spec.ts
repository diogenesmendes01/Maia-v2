/**
 * Smoke tests para as 5 tools calendar_* (read-only), sempre habilitadas
 * (PR #406: Calendar v2 collapsed to always-on — sem feature flag).
 *
 * Cobre o caminho feliz de cada tool E a validação de limites (bounds). A
 * lógica de cálculo (DB-backed, tenant-aware) vive em
 * `src/lib/business-days.ts`; aqui mockamos o repositório de feriados
 * (`holidaysRepo.findInRange`) — o MESMO ponto de mock usado em
 * `tests/unit/business-day-rrule.spec.ts` — para que o handler real exercite a
 * lógica real sobre um conjunto determinístico de feriados, sem banco. Cobertura
 * de integração tenant-aware: `tests/integration/calendar-v2-*.spec.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the holidays repo at the SAME layer as business-day-rrule.spec.ts. The
// real business-days.ts then computes over this deterministic national set
// (New Year 01/01 + Labour Day 01/05) with no real DB.
const { findInRangeMock } = vi.hoisted(() => ({ findInRangeMock: vi.fn() }));

vi.mock('../../src/db/repositories/holidays-repo.js', () => ({
  holidaysRepo: { findInRange: findInRangeMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { calendarIsBusinessDayTool } from '@/tools/calendar/calendar-is-business-day.js';
import { calendarNextHolidayTool } from '@/tools/calendar/calendar-next-holiday.js';
import { calendarListHolidaysTool } from '@/tools/calendar/calendar-list-holidays.js';
import { calendarBusinessDaysBetweenTool } from '@/tools/calendar/calendar-business-days-between.js';
import { calendarAddBusinessDaysTool } from '@/tools/calendar/calendar-add-business-days.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { _internal_cache } from '../../src/lib/holidays-cache.js';

const dummyCtx = {} as never;
const TENANT_CTX = { tenant_id: 'tenant-cal', agent_id: 'default' };

// Two national holidays in the {month, day, name, type} shape findInRange
// returns: New Year (01/01) and Labour Day (01/05). The business-days cache is
// tenant+entidade-scoped, so returning the national set for any range is fine.
const NATIONAL_2026 = [
  { month: 1, day: 1, name: 'Confraternização Universal', type: 'national' },
  { month: 5, day: 1, name: 'Dia do Trabalho', type: 'national' },
];

beforeEach(() => {
  findInRangeMock.mockReset();
  findInRangeMock.mockResolvedValue(NATIONAL_2026);
  // Reset the tenant-aware LRU so each test recomputes from the mock.
  _internal_cache.clear();
});

describe('calendar_* tools — smoke (always-on, holidays mocked)', () => {
  it('calendar_is_business_day — feriado (01/01, quinta) NÃO é dia útil', async () => {
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarIsBusinessDayTool.handler({ date: '2026-01-01' }, dummyCtx),
    );
    expect(res.is_business_day).toBe(false);
    expect(res.date).toBe('2026-01-01');
    expect(res.calendar_v2_enabled).toBe(true);
  });

  it('calendar_is_business_day — dia normal (02/01, sexta) É dia útil', async () => {
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarIsBusinessDayTool.handler({ date: '2026-01-02' }, dummyCtx),
    );
    expect(res.is_business_day).toBe(true);
  });

  it('calendar_next_holiday — a partir de 22/04 retorna o Dia do Trabalho (01/05)', async () => {
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarNextHolidayTool.handler({ from: '2026-04-22' }, dummyCtx),
    );
    expect(res.holiday).not.toBeNull();
    expect(res.holiday?.date).toBe('2026-05-01');
    expect(res.holiday?.name).toBe('Dia do Trabalho');
  });

  it('calendar_list_holidays — lista os feriados do ano em ordem cronológica', async () => {
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarListHolidaysTool.handler(
        { start: '2026-01-01', end: '2026-12-31' },
        dummyCtx,
      ),
    );
    expect(res.holidays.map((h) => h.date)).toEqual(['2026-01-01', '2026-05-01']);
  });

  it('calendar_business_days_between — 01/01..07/01 conta 4 dias úteis (1 feriado + fim de semana)', async () => {
    // Jan 2026: 1=feriado(qui), 3=sáb, 4=dom → úteis = {2,5,6,7} = 4; total = 7.
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarBusinessDaysBetweenTool.handler(
        { start: '2026-01-01', end: '2026-01-07' },
        dummyCtx,
      ),
    );
    expect(res.total_days).toBe(7);
    expect(res.business_days).toBe(4);
  });

  it('calendar_add_business_days — 02/01 (sexta) + 1 dia útil pula o fim de semana → 05/01 (segunda)', async () => {
    const res = await runWithTenantContext(TENANT_CTX, () =>
      calendarAddBusinessDaysTool.handler({ date: '2026-01-02', count: 1 }, dummyCtx),
    );
    expect(res.result_date).toBe('2026-01-05');
  });
});

describe('calendar_* tools — contracts (bounds validation)', () => {
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
