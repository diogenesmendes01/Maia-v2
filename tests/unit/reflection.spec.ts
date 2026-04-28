import { describe, it, expect } from 'vitest';
import { detectCorrection } from '../../src/agent/reflection.js';

describe('reflection — detectCorrection', () => {
  it('detecta "não"', () => {
    expect(detectCorrection('não, é Empresa 3')).toBe(true);
  });
  it('detecta "errado"', () => {
    expect(detectCorrection('errado, isso é da PF')).toBe(true);
  });
  it('detecta "cancela"', () => {
    expect(detectCorrection('cancela esse lançamento')).toBe(true);
  });
  it('não dispara em frases neutras', () => {
    expect(detectCorrection('lança R$ 50 mercado')).toBe(false);
  });
});
