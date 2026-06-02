/**
 * Smoke tests para as 5 tools calendar_* (read-only). Foco no contrato de
 * input/output (validação de limites). A lógica de cálculo (DB-backed,
 * tenant-aware) é coberta em business-days.spec.ts e nos testes de integração
 * calendar-v2-*.
 */
import { describe, it, expect, vi } from 'vitest';

import { calendarBusinessDaysBetweenTool } from '@/tools/calendar/calendar-business-days-between.js';
import { calendarAddBusinessDaysTool } from '@/tools/calendar/calendar-add-business-days.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const dummyCtx = {} as never;

describe('calendar_* tools — contracts', () => {
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
