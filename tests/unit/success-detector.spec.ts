import { describe, it, expect } from 'vitest';
import { detectSuccess } from '@/agent/success-detector.js';

describe('detectSuccess', () => {
  it('detecta sinais positivos óbvios', () => {
    expect(detectSuccess('perfeito, obrigado!')).toBe(true);
    expect(detectSuccess('exatamente isso')).toBe(true);
    expect(detectSuccess('fechou!')).toBe(true);
    expect(detectSuccess('ok pode mandar')).toBe(true);
  });

  it('não detecta sinais neutros', () => {
    expect(detectSuccess('ok')).toBe(false);
    expect(detectSuccess('entendi')).toBe(false);
    expect(detectSuccess('me explica de novo')).toBe(false);
  });

  it('não detecta correções', () => {
    expect(detectSuccess('não, errado')).toBe(false);
    expect(detectSuccess('isso tá errado')).toBe(false);
  });
});
