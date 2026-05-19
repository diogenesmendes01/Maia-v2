import { describe, it, expect } from 'vitest';
import {
  VISIBLE_LIFECYCLE_STATES,
  isVisible,
} from '@/user-layer/internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '@/user-layer/types.js';

describe('user-layer visibility predicates', () => {
  const allStates: KnowledgeLifecycleStatus[] = [
    'proposed',
    'pending_review',
    'ephemeral',
    'observed',
    'reinforced',
    'verified',
    'active',
    'deprecated',
    'revoked',
  ];

  it('VISIBLE_LIFECYCLE_STATES contains exactly the 5 contextable states', () => {
    expect(VISIBLE_LIFECYCLE_STATES).toHaveLength(5);
    expect(new Set(VISIBLE_LIFECYCLE_STATES)).toEqual(
      new Set(['ephemeral', 'observed', 'reinforced', 'verified', 'active']),
    );
  });

  it('isVisible returns true only for states in VISIBLE_LIFECYCLE_STATES', () => {
    for (const state of allStates) {
      const expected = (VISIBLE_LIFECYCLE_STATES as readonly string[]).includes(state);
      expect(isVisible(state)).toBe(expected);
    }
  });

  it('isVisible rejects "proposed" (awaiting decision)', () => {
    expect(isVisible('proposed')).toBe(false);
  });

  it('isVisible rejects "pending_review" (awaiting human)', () => {
    expect(isVisible('pending_review')).toBe(false);
  });

  it('isVisible rejects "deprecated" (superseded)', () => {
    expect(isVisible('deprecated')).toBe(false);
  });

  it('isVisible rejects "revoked" (removed by incident/drift)', () => {
    expect(isVisible('revoked')).toBe(false);
  });

  it('isVisible accepts "active" (default legacy)', () => {
    expect(isVisible('active')).toBe(true);
  });
});
