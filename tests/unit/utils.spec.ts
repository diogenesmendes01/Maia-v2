import { describe, it, expect } from 'vitest';
import { canonicalize, canonicalJSON, trigramSim, bucket5min, sha256 } from '../../src/lib/utils.js';

describe('utils — canonicalize', () => {
  it('ordena chaves', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
  });
  it('aninha', () => {
    expect(canonicalJSON({ x: { b: 1, a: 2 } })).toBe(canonicalJSON({ x: { a: 2, b: 1 } }));
  });
});

describe('utils — bucket5min', () => {
  it('mesmo bucket', () => {
    const a = bucket5min(new Date('2026-04-28T14:32:00Z'));
    const b = bucket5min(new Date('2026-04-28T14:34:59Z'));
    expect(a).toBe(b);
  });
  it('bucket diferente', () => {
    const a = bucket5min(new Date('2026-04-28T14:34:59Z'));
    const b = bucket5min(new Date('2026-04-28T14:35:00Z'));
    expect(a).not.toBe(b);
  });
});

describe('utils — trigramSim', () => {
  it('strings iguais → 1', () => {
    expect(trigramSim('aluguel', 'aluguel')).toBe(1);
  });
  it('totalmente diferente → ~0', () => {
    expect(trigramSim('xyz', 'qwertyu')).toBeLessThan(0.3);
  });
});

describe('utils — sha256', () => {
  it('determinístico', () => {
    expect(sha256('foo')).toBe(sha256('foo'));
  });
  it('produz 64 chars hex', () => {
    expect(sha256('foo')).toMatch(/^[0-9a-f]{64}$/);
  });
});
