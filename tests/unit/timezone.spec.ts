import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo' },
}));

import { isValidIanaTimeZone, resolveInterlocutorTz } from '../../src/lib/timezone.js';

describe('isValidIanaTimeZone', () => {
  it('accepts known IANA zones', () => {
    expect(isValidIanaTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidIanaTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
  });

  it('rejects unknown / malformed zones and empty input', () => {
    expect(isValidIanaTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidIanaTimeZone('not a zone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
  });
});

describe('resolveInterlocutorTz', () => {
  it('uses the persisted per-person zone when valid', () => {
    expect(resolveInterlocutorTz({ preferencias: { timezone: 'Europe/Lisbon' } })).toBe(
      'Europe/Lisbon',
    );
  });

  it('falls back to config.TZ when absent, invalid, or non-string', () => {
    expect(resolveInterlocutorTz({ preferencias: {} })).toBe('America/Sao_Paulo');
    expect(resolveInterlocutorTz({ preferencias: { timezone: 'Bad/Zone' } })).toBe(
      'America/Sao_Paulo',
    );
    expect(resolveInterlocutorTz({ preferencias: { timezone: 42 } })).toBe('America/Sao_Paulo');
    expect(resolveInterlocutorTz(null)).toBe('America/Sao_Paulo');
    expect(resolveInterlocutorTz(undefined)).toBe('America/Sao_Paulo');
  });
});
