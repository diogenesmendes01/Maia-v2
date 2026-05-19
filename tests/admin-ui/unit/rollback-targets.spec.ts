/**
 * P8.5 — rollback target validation tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isSupportedSotKind,
  validateRollbackTarget,
  suggestRollbackTarget,
} from '@/admin-ui/lib/rollback-targets.js';

describe('isSupportedSotKind', () => {
  it('accepts the 4 known SoT kinds', () => {
    expect(isSupportedSotKind('agent_operational_profile_versions')).toBe(true);
    expect(isSupportedSotKind('policy_rules')).toBe(true);
    expect(isSupportedSotKind('soul_biases')).toBe(true);
    expect(isSupportedSotKind('skills')).toBe(true);
  });

  it('rejects unknown kinds', () => {
    expect(isSupportedSotKind('arbitrary_table')).toBe(false);
    expect(isSupportedSotKind('')).toBe(false);
  });
});

describe('validateRollbackTarget', () => {
  it('accepts target < current for supported kind', () => {
    expect(validateRollbackTarget('policy_rules', 5, 3)).toBe(true);
    expect(validateRollbackTarget('policy_rules', 5, 1)).toBe(true);
  });

  it('rejects same version', () => {
    expect(validateRollbackTarget('policy_rules', 5, 5)).toBe(false);
  });

  it('rejects rollforward (target > current)', () => {
    expect(validateRollbackTarget('policy_rules', 5, 6)).toBe(false);
  });

  it('rejects zero or negative version', () => {
    expect(validateRollbackTarget('policy_rules', 5, 0)).toBe(false);
    expect(validateRollbackTarget('policy_rules', 5, -1)).toBe(false);
  });

  it('rejects unsupported SoT', () => {
    expect(validateRollbackTarget('foo_table', 5, 3)).toBe(false);
  });
});

describe('suggestRollbackTarget', () => {
  it('returns the highest non-rolled-back version below current', () => {
    const target = suggestRollbackTarget('policy_rules', 5, [
      { version: 4, status: 'active' },
      { version: 3, status: 'rolled_back' },
      { version: 2, status: 'active' },
      { version: 1, status: 'active' },
    ]);
    expect(target).toBe(4);
  });

  it('skips rolled-back versions', () => {
    const target = suggestRollbackTarget('policy_rules', 5, [
      { version: 4, status: 'rolled_back' },
      { version: 3, status: 'active' },
    ]);
    expect(target).toBe(3);
  });

  it('returns null when no candidate exists', () => {
    expect(suggestRollbackTarget('policy_rules', 1, [])).toBeNull();
  });

  it('returns null for unsupported kind', () => {
    expect(suggestRollbackTarget('foo', 5, [{ version: 3, status: 'active' }])).toBeNull();
  });
});
