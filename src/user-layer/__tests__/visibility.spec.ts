import { describe, it, expect } from 'vitest';
import { VISIBLE_LIFECYCLE_STATES, isVisible } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

describe('visibility predicates', () => {
  const allStates: KnowledgeLifecycleStatus[] = [
    'proposed', 'pending_review', 'ephemeral', 'observed',
    'reinforced', 'verified', 'active', 'deprecated', 'revoked',
  ];

  it('VISIBLE_LIFECYCLE_STATES contains exactly 5 states', () => {
    expect(VISIBLE_LIFECYCLE_STATES).toHaveLength(5);
  });

  it('isVisible returns true only for states in VISIBLE_LIFECYCLE_STATES', () => {
    allStates.forEach((state) => {
      const expected = VISIBLE_LIFECYCLE_STATES.includes(state);
      expect(isVisible(state)).toBe(expected);
    });
  });
});
