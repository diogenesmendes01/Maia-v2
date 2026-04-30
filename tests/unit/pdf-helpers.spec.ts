import { describe, it, expect } from 'vitest';
import { slugify, formatPeriodBR, fmtBRLSigned } from '../../src/lib/pdf/_helpers.js';

describe('pdf helpers — slugify', () => {
  it('lowercases, strips diacritics, collapses spaces to hyphens', () => {
    expect(slugify('Empresa Açaí & Cia')).toBe('empresa-acai-cia');
    expect(slugify('  São Paulo  ')).toBe('sao-paulo');
    expect(slugify('A')).toBe('a');
  });

  it('handles empty / whitespace-only input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('pdf helpers — formatPeriodBR', () => {
  it('formats a date range as "dd/MM/yyyy a dd/MM/yyyy"', () => {
    expect(formatPeriodBR('2026-04-01', '2026-04-30')).toBe('01/04/2026 a 30/04/2026');
  });
});

describe('pdf helpers — fmtBRLSigned', () => {
  it('positive values format with R$ prefix', () => {
    expect(fmtBRLSigned(1234.56)).toBe('R$ 1.234,56');
  });

  it('negative values keep the minus sign', () => {
    expect(fmtBRLSigned(-99.9)).toContain('-');
    expect(fmtBRLSigned(-99.9)).toContain('99,90');
  });

  it('zero formats as R$ 0,00', () => {
    expect(fmtBRLSigned(0)).toBe('R$ 0,00');
  });
});
