import { describe, it, expect } from 'vitest';
import { detectUserSignal } from '@/cognition/step-evaluator-user-signal.js';

describe('detectUserSignal', () => {
  it('agreement positive matches "sim, pode ser" → passed=true, matched=positive', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: 'sim, pode ser' });
    expect(r.passed).toBe(true);
    expect(r.matched).toBe('positive');
  });

  it('agreement negative matches "não, obrigado" → passed=false, matched=negative', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: 'não, obrigado' });
    expect(r.passed).toBe(false);
    expect(r.matched).toBe('negative');
  });

  it('denial inverts: "não quero" passes for signal=denial → passed=true', () => {
    const r = detectUserSignal({ signal: 'denial', user_message: 'não quero' });
    expect(r.passed).toBe(true);
    expect(r.matched).toBe('positive');
  });

  it('custom uses provided patterns: positive_patterns matches msg → passed=true', () => {
    const r = detectUserSignal({
      signal: 'custom',
      positive_patterns: ['quero comprar'],
      user_message: 'eu quero comprar agora',
    });
    expect(r.passed).toBe(true);
    expect(r.matched).toBe('positive');
  });

  it('empty message → matched=none', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: '' });
    expect(r.matched).toBe('none');
    expect(r.passed).toBe(false);
  });

  it('negative AND positive both present: negative wins ("não, mas pode ser") → passed=false', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: 'não, mas pode ser' });
    expect(r.passed).toBe(false);
    expect(r.matched).toBe('negative');
  });

  it('custom with no matching pattern → matched=none', () => {
    const r = detectUserSignal({
      signal: 'custom',
      positive_patterns: ['quero comprar'],
      user_message: 'olá, tudo bem?',
    });
    expect(r.passed).toBe(false);
    expect(r.matched).toBe('none');
  });

  it('custom with negative_patterns wins over positive', () => {
    const r = detectUserSignal({
      signal: 'custom',
      positive_patterns: ['quero'],
      negative_patterns: ['não quero'],
      user_message: 'não quero comprar',
    });
    expect(r.passed).toBe(false);
    expect(r.matched).toBe('negative');
  });

  it('custom safely handles invalid regex by treating as literal', () => {
    const r = detectUserSignal({
      signal: 'custom',
      positive_patterns: ['('],
      user_message: 'tenho um ( aqui',
    });
    expect(r.passed).toBe(true);
    expect(r.matched).toBe('positive');
  });

  it('whitespace-only message → matched=none', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: '   ' });
    expect(r.matched).toBe('none');
    expect(r.passed).toBe(false);
  });
});
