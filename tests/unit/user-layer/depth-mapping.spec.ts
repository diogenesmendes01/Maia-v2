import { describe, it, expect } from 'vitest';
import {
  getUserMaxItems,
  getKnowledgeMaxes,
} from '@/user-layer/internal/depth-mapping.js';

describe('user-layer depth-mapping', () => {
  describe('getUserMaxItems (UserSlice)', () => {
    it('none → 0 items', () => {
      expect(getUserMaxItems('none')).toBe(0);
    });

    it('minimal → 5 items', () => {
      expect(getUserMaxItems('minimal')).toBe(5);
    });

    it('relevant → 15 items', () => {
      expect(getUserMaxItems('relevant')).toBe(15);
    });

    it('deep → 50 items', () => {
      expect(getUserMaxItems('deep')).toBe(50);
    });

    it('respects override when provided', () => {
      expect(getUserMaxItems('relevant', 25)).toBe(25);
      expect(getUserMaxItems('deep', 100)).toBe(100);
    });

    it('override=0 is honored (caller wants zero items)', () => {
      expect(getUserMaxItems('relevant', 0)).toBe(0);
    });
  });

  describe('getKnowledgeMaxes (KnowledgeSlice)', () => {
    it('none → 0 facts, 0 rules', () => {
      expect(getKnowledgeMaxes('none')).toEqual({ facts: 0, rules: 0 });
    });

    it('relevant → 10 facts, 5 rules', () => {
      expect(getKnowledgeMaxes('relevant')).toEqual({ facts: 10, rules: 5 });
    });

    it('deep → 50 facts, 30 rules', () => {
      expect(getKnowledgeMaxes('deep')).toEqual({ facts: 50, rules: 30 });
    });

    it('respects facts override', () => {
      expect(getKnowledgeMaxes('relevant', { facts: 100 })).toEqual({
        facts: 100,
        rules: 5,
      });
    });

    it('respects rules override', () => {
      expect(getKnowledgeMaxes('deep', { rules: 99 })).toEqual({
        facts: 50,
        rules: 99,
      });
    });

    it('respects both overrides', () => {
      expect(getKnowledgeMaxes('none', { facts: 7, rules: 3 })).toEqual({
        facts: 7,
        rules: 3,
      });
    });
  });
});
