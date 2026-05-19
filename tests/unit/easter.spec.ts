import { describe, it, expect } from 'vitest';
import { easter } from '../../src/lib/easter.js';

// Tabela verdade — datas históricas Easter (UTC)
const TRUTH: Array<[number, string]> = [
  [2025, '2025-04-20'],
  [2026, '2026-04-05'],
  [2027, '2027-03-28'],
  [2028, '2028-04-16'],
  [2029, '2029-04-01'],
  [2030, '2030-04-21'],
  [2031, '2031-04-13'],
  [2032, '2032-03-28'],
  [2033, '2033-04-17'],
  [2034, '2034-04-09'],
  [2035, '2035-03-25'],
];

describe('easter (Meeus-Jones-Butcher)', () => {
  for (const [year, expected] of TRUTH) {
    it(`year ${year} = ${expected}`, () => {
      const d = easter(year);
      expect(d.toISOString().slice(0, 10)).toBe(expected);
    });
  }
});
