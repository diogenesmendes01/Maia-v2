import { describe, it, expect } from 'vitest';
import {
  GapLevel,
  ProposalStatus,
  CapabilityTestOutcome,
  FeatureFlagName,
} from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

describe('P5 enums', () => {
  it('GapLevel has 4 values', () => {
    expect(Object.values(GapLevel).sort()).toEqual([
      'dashboard',
      'mentionable',
      'proposed',
      'silent',
    ]);
  });
  it('ProposalStatus has 5 values', () => {
    expect(Object.values(ProposalStatus)).toHaveLength(5);
  });
  it('CapabilityTestOutcome has 3 values', () => {
    expect(Object.values(CapabilityTestOutcome).sort()).toEqual(['error', 'fail', 'pass']);
  });
  it('FeatureFlagName.DIALOGICAL_ACQUISITION defined', () => {
    expect(FeatureFlagName.DIALOGICAL_ACQUISITION).toBe('DIALOGICAL_ACQUISITION');
  });
  it('featureFlags singleton respects FEATURE_DIALOGICAL_ACQUISITION default off', () => {
    expect(featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)).toBe(false);
  });
});
