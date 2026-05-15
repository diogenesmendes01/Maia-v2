import { describe, it, expect } from 'vitest';
import { canTransition, validateTransition } from '@/cognition/procedure-status.js';

describe('canTransition', () => {
  it('aceita draft → proposed', () => {
    expect(canTransition('draft', 'proposed')).toBe(true);
  });
  it('aceita proposed → active', () => {
    expect(canTransition('proposed', 'active')).toBe(true);
  });
  it('aceita proposed → draft (rejection)', () => {
    expect(canTransition('proposed', 'draft')).toBe(true);
  });
  it('aceita active → frozen', () => {
    expect(canTransition('active', 'frozen')).toBe(true);
  });
  it('aceita active → rolled_back', () => {
    expect(canTransition('active', 'rolled_back')).toBe(true);
  });
  it('aceita frozen → active (unfreeze)', () => {
    expect(canTransition('frozen', 'active')).toBe(true);
  });
  it('rejeita rolled_back → qualquer coisa (terminal)', () => {
    expect(canTransition('rolled_back', 'active')).toBe(false);
    expect(canTransition('rolled_back', 'draft')).toBe(false);
  });
  it('rejeita draft → active diretamente (precisa passar por proposed)', () => {
    expect(canTransition('draft', 'active')).toBe(false);
  });
});

describe('validateTransition', () => {
  it('throws ao tentar transition inválida', () => {
    expect(() => validateTransition('rolled_back', 'active')).toThrow();
  });
  it('não throws em transition válida', () => {
    expect(() => validateTransition('draft', 'proposed')).not.toThrow();
  });
});
