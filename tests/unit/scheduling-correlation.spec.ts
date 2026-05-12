import { describe, it, expect } from 'vitest';
import {
  newCorrelationToken,
  appendCorrelationFooter,
  extractCorrelationToken,
} from '../../src/scheduling/correlation.js';

describe('correlation token', () => {
  it('newCorrelationToken returns a 4-hex string', () => {
    for (let i = 0; i < 50; i++) {
      const t = newCorrelationToken();
      expect(t).toMatch(/^[0-9A-F]{4}$/);
    }
  });

  it('appendCorrelationFooter adds the ref pattern in a way extractCorrelationToken can read', () => {
    const t = 'A4F2';
    const wrapped = appendCorrelationFooter('Oi Mariana, o relatório?', t);
    expect(wrapped).toContain('_ref: A4F2_');
    expect(extractCorrelationToken(wrapped)).toBe('A4F2');
  });

  it('extractCorrelationToken returns null when no pattern present', () => {
    expect(extractCorrelationToken('Oi, segue em anexo')).toBeNull();
  });

  it('extractCorrelationToken is case-insensitive', () => {
    expect(extractCorrelationToken('aqui está  _ref: a4f2_ obrigado')).toBe('A4F2');
  });

  it('extractCorrelationToken finds a token even with surrounding text', () => {
    const sample =
      'Oi! Segue o relatório que você pediu. Qualquer dúvida me chama. _ref: B3D1_';
    expect(extractCorrelationToken(sample)).toBe('B3D1');
  });
});
