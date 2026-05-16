import { describe, it, expect } from 'vitest';
import {
  nationalMovingHolidays,
  NATIONAL_FIXED,
} from '../../src/lib/national-holidays.js';

describe('national holidays', () => {
  it('moving holidays 2026', () => {
    const list = nationalMovingHolidays(2026);
    const map = Object.fromEntries(
      list.map((h) => [h.name, h.date.toISOString().slice(0, 10)]),
    );
    expect(map['Carnaval — Segunda']).toBe('2026-02-16');
    expect(map['Carnaval — Terça']).toBe('2026-02-17');
    expect(map['Sexta-feira Santa']).toBe('2026-04-03');
    expect(map['Páscoa']).toBe('2026-04-05');
    expect(map['Corpus Christi']).toBe('2026-06-04');
  });

  it('NATIONAL_FIXED has 9 entries with Natal Dec 25', () => {
    expect(NATIONAL_FIXED).toHaveLength(9);
    expect(NATIONAL_FIXED.find((h) => h.name === 'Natal')).toEqual({
      name: 'Natal',
      month: 12,
      day: 25,
    });
  });
});
