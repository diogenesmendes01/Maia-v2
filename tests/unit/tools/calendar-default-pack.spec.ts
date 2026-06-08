import { describe, it, expect } from 'vitest';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import {
  DEFAULT_AGENT_PACKS,
  PLATFORM_DEFAULT_DOMAIN_PACKS,
  DOMAIN_CALENDAR_PACK,
  DOMAIN_CALENDAR_ADMIN_PACK,
} from '@/tools/grant-math.js';

describe('calendar default pack — estrutura', () => {
  it('BASE_AGENT_PACKS = baseline.core + domain.calendar (parity)', () => {
    expect([...BASE_AGENT_PACKS]).toEqual([
      ...DEFAULT_AGENT_PACKS,
      ...PLATFORM_DEFAULT_DOMAIN_PACKS,
    ]);
    expect(BASE_AGENT_PACKS).toContain('baseline.core');
    expect(BASE_AGENT_PACKS).toContain('domain.calendar');
  });

  it('domain.calendar tem as 7 tools universais, SEM register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_PACK.tools).toHaveLength(7);
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('schedule_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('cancel_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).not.toContain('register_custom_holiday');
  });

  it('domain.calendar.admin isola o register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_ADMIN_PACK.id).toBe('domain.calendar.admin');
    expect(DOMAIN_CALENDAR_ADMIN_PACK.tools).toEqual(['register_custom_holiday']);
  });
});
