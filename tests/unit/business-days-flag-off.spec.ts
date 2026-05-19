import { describe, it, expect, beforeEach, vi } from 'vitest';
import { featureFlags } from '../../src/config/feature-flags.js';
import { FeatureFlagName } from '../../src/types/enums.js';
import { isBusinessDayBR } from '../../src/lib/business-days.js';

describe('FEATURE_CALENDAR_V2 flag', () => {
  it('exists in FeatureFlagName enum', () => {
    expect(FeatureFlagName.CALENDAR_V2).toBe('calendar_v2');
  });
  it('defaults to false', () => {
    // Reset overrides so default is observed
    featureFlags.reset();
    expect(featureFlags.isEnabled(FeatureFlagName.CALENDAR_V2)).toBe(false);
  });
});

describe('isBusinessDayBR (flag OFF, legacy)', () => {
  beforeEach(() => {
    vi.spyOn(featureFlags, 'isEnabled').mockReturnValue(false);
  });

  it('Corpus Christi 2026-06-04 ainda é feriado via hard-coded fallback', async () => {
    const result = await isBusinessDayBR(new Date('2026-06-04T12:00:00Z'));
    expect(result).toBe(false);
  });

  it('Sexta 23/01/2026 (não-feriado nacional) é dia útil', async () => {
    const result = await isBusinessDayBR(new Date('2026-01-23T12:00:00Z'));
    expect(result).toBe(true);
  });

  it('Sábado 06/06/2026 não é dia útil (legacy = standard, sem clt)', async () => {
    const result = await isBusinessDayBR(new Date('2026-06-06T12:00:00Z'));
    expect(result).toBe(false);
  });

  it('Domingo 07/06/2026 não é dia útil', async () => {
    const result = await isBusinessDayBR(new Date('2026-06-07T12:00:00Z'));
    expect(result).toBe(false);
  });

  it('Natal 25/12/2026 não é dia útil', async () => {
    const result = await isBusinessDayBR(new Date('2026-12-25T12:00:00Z'));
    expect(result).toBe(false);
  });

  it('Páscoa 05/04/2026 é domingo (não dia útil)', async () => {
    const result = await isBusinessDayBR(new Date('2026-04-05T12:00:00Z'));
    expect(result).toBe(false);
  });
});
