import { describe, it, expect } from 'vitest';
import { parseDecision, maskPhone } from '../../src/identity/quarantine-utils.js';

describe('quarantine — decision parser', () => {
  it('accepts affirmative variants', () => {
    expect(parseDecision('sim')).toBe('aprova');
    expect(parseDecision('Sim, libera')).toBe('aprova');
    expect(parseDecision('aprova')).toBe('aprova');
    expect(parseDecision('  ok  ')).toBe('aprova');
  });

  it('accepts blocking variants', () => {
    expect(parseDecision('não')).toBe('bloqueia');
    expect(parseDecision('nao')).toBe('bloqueia');
    expect(parseDecision('bloqueia')).toBe('bloqueia');
  });

  it('returns null for ambiguous input', () => {
    expect(parseDecision('talvez')).toBeNull();
    expect(parseDecision('')).toBeNull();
  });

  it('masks phone keeping prefix and last 2 digits', () => {
    expect(maskPhone('+5511999998888')).toBe('+551*****88');
    expect(maskPhone('+1')).toBe('***');
  });
});
