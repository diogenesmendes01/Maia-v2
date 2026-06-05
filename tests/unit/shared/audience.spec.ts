import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_TYPES,
  TRUST_LEVELS,
  isAudienceType,
  isTrustLevel,
  type AudienceType,
  type TrustLevel,
} from '@/shared/audience.js';

describe('src/shared/audience — canonical enums (#407 foundation)', () => {
  it('AUDIENCE_TYPES is the exact set the issue specifies', () => {
    expect([...AUDIENCE_TYPES]).toEqual([
      'owner',
      'manager',
      'employee',
      'accountant',
      'customer',
      'vendor',
      'lead',
      'system_user',
      'unknown',
    ]);
  });

  it('TRUST_LEVELS is the exact set the issue specifies', () => {
    expect([...TRUST_LEVELS]).toEqual([
      'trusted_internal',
      'known_external',
      'unverified',
      'unknown',
      'blocked',
    ]);
  });

  it('arrays are frozen `as const` literals (no accidental mutation across modules)', () => {
    // `as const` makes them readonly at the type level; assert the values are
    // stable so a downstream issue (#409) reusing them cannot be surprised by
    // reordering.
    const audience: readonly AudienceType[] = AUDIENCE_TYPES;
    const trust: readonly TrustLevel[] = TRUST_LEVELS;
    expect(audience.length).toBe(9);
    expect(trust.length).toBe(5);
    expect(new Set(audience).size).toBe(audience.length); // no dups
    expect(new Set(trust).size).toBe(trust.length);
  });

  it('isAudienceType recognises every legal value and rejects others', () => {
    for (const v of AUDIENCE_TYPES) expect(isAudienceType(v)).toBe(true);
    expect(isAudienceType('cliente')).toBe(false); // legacy pt-BR tipo
    expect(isAudienceType('')).toBe(false);
    expect(isAudienceType(null)).toBe(false);
    expect(isAudienceType(42)).toBe(false);
  });

  it('isTrustLevel recognises every legal value and rejects others', () => {
    for (const v of TRUST_LEVELS) expect(isTrustLevel(v)).toBe(true);
    expect(isTrustLevel('trusted')).toBe(false);
    expect(isTrustLevel(undefined)).toBe(false);
  });
});
