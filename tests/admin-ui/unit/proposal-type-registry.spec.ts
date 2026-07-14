/**
 * P8.5 — proposal type registry tests.
 */
import { describe, it, expect } from 'vitest';
import {
  proposalTypeRegistry,
  getDiffComponent,
  getDisplayName,
  isValidRiskFor,
} from '@/admin-ui/lib/proposal-type-registry.js';

describe('proposalTypeRegistry', () => {
  it('covers all 5 proposal types', () => {
    expect(Object.keys(proposalTypeRegistry)).toEqual([
      'policy_rule',
      'soul_bias',
      'skill',
      'capability_proposal',
      'knowledge_proposal',
    ]);
  });

  it('every entry has a diff component name', () => {
    for (const def of Object.values(proposalTypeRegistry)) {
      expect(def.diffComponent).toMatch(/^Diff[A-Z]/);
    }
  });

  it('every entry has at least one risk level', () => {
    for (const def of Object.values(proposalTypeRegistry)) {
      expect(def.riskLevels.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('helpers', () => {
  it('getDiffComponent returns DiffPolicyRule for policy_rule', () => {
    expect(getDiffComponent('policy_rule')).toBe('DiffPolicyRule');
  });

  it('getDisplayName returns "Capability" for capability_proposal', () => {
    expect(getDisplayName('capability_proposal')).toBe('Capability');
  });

  it('isValidRiskFor rejects "critical" for skill (not in supported levels)', () => {
    expect(isValidRiskFor('skill', 'critical')).toBe(false);
    expect(isValidRiskFor('skill', 'high')).toBe(true);
  });
});
