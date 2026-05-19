/**
 * P9d — `field-path.ts` unit tests.
 *
 * Coverage targets:
 *  - Empty path returns root.
 *  - Dot-delimited splits walk plain objects.
 *  - Numeric segments index arrays; non-numeric segments don't.
 *  - Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are
 *    rejected as unresolvable even when present as own properties.
 *  - Walking through `null`/`undefined`/primitives returns `undefined`.
 *  - Paths exceeding `MAX_FIELD_PATH_DEPTH` are flagged via
 *    `isFieldPathTooDeep` and resolve to `undefined`.
 */
import { describe, it, expect } from 'vitest';
import {
  isFieldPathTooDeep,
  resolveFieldPath,
  splitFieldPath,
} from '@/governance/policy-dsl/field-path.js';
import { MAX_FIELD_PATH_DEPTH } from '@/governance/policy-dsl/constants.js';

describe('splitFieldPath', () => {
  it('returns [] for empty path', () => {
    expect(splitFieldPath('')).toEqual([]);
  });
  it('splits dot-delimited paths', () => {
    expect(splitFieldPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });
  it('preserves empty middle segments', () => {
    expect(splitFieldPath('a..b')).toEqual(['a', '', 'b']);
  });
});

describe('resolveFieldPath', () => {
  it('returns root for empty path', () => {
    expect(resolveFieldPath({ a: 1 }, '')).toEqual({ a: 1 });
  });
  it('walks plain object properties', () => {
    expect(resolveFieldPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns undefined for missing keys', () => {
    expect(resolveFieldPath({ a: { b: 1 } }, 'a.x')).toBeUndefined();
  });
  it('treats traversal through null/undefined as unresolvable', () => {
    expect(resolveFieldPath({ a: null }, 'a.b')).toBeUndefined();
    expect(resolveFieldPath({ a: undefined }, 'a.b')).toBeUndefined();
  });
  it('treats traversal through a primitive as unresolvable', () => {
    expect(resolveFieldPath({ a: 'hello' }, 'a.length')).toBeUndefined();
  });
  it('indexes arrays by numeric segments', () => {
    expect(resolveFieldPath({ xs: [10, 20, 30] }, 'xs.1')).toBe(20);
  });
  it('returns undefined for non-numeric segments on arrays', () => {
    expect(resolveFieldPath({ xs: [10, 20] }, 'xs.foo')).toBeUndefined();
  });
  it('returns undefined for negative array indices', () => {
    expect(resolveFieldPath({ xs: [10, 20] }, 'xs.-1')).toBeUndefined();
  });
  it('returns undefined for out-of-bounds array indices', () => {
    expect(resolveFieldPath({ xs: [10, 20] }, 'xs.5')).toBeUndefined();
  });
  it('rejects prototype keys', () => {
    expect(resolveFieldPath({}, '__proto__')).toBeUndefined();
    expect(resolveFieldPath({}, 'constructor')).toBeUndefined();
    expect(resolveFieldPath({}, 'prototype.foo')).toBeUndefined();
  });
  it('does not walk inherited properties (only own)', () => {
    class Animal {
      kind = 'dog';
    }
    const a = new Animal();
    // `kind` is own → resolves
    expect(resolveFieldPath(a, 'kind')).toBe('dog');
    // anything else (including inherited methods) → undefined
    expect(resolveFieldPath(a, 'toString')).toBeUndefined();
  });
});

describe('isFieldPathTooDeep', () => {
  it('returns false for paths within the bound', () => {
    expect(isFieldPathTooDeep('a.b.c')).toBe(false);
  });
  it('returns true for paths exceeding the bound', () => {
    const segments = Array.from(
      { length: MAX_FIELD_PATH_DEPTH + 1 },
      (_, i) => `s${i}`,
    );
    expect(isFieldPathTooDeep(segments.join('.'))).toBe(true);
  });
  it('returns false for an empty path', () => {
    expect(isFieldPathTooDeep('')).toBe(false);
  });
  it('treats too-deep paths as unresolvable in resolveFieldPath', () => {
    const segments = Array.from(
      { length: MAX_FIELD_PATH_DEPTH + 1 },
      () => 'a',
    );
    expect(resolveFieldPath({ a: 1 }, segments.join('.'))).toBeUndefined();
  });
});
