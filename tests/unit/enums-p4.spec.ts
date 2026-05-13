import { describe, it, expect } from 'vitest';
import {
  DriftType,
  DriftSeverity,
  ProfileStatus,
  DriftDecision,
  FeatureFlagName,
} from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

describe('P4 enums', () => {
  it('DriftType has 7 values', () => {
    expect(Object.values(DriftType)).toHaveLength(7);
  });
  it('DriftSeverity has 4 values', () => {
    expect(Object.values(DriftSeverity)).toHaveLength(4);
  });
  it('ProfileStatus = proposed/active/frozen/rolled_back', () => {
    expect(Object.values(ProfileStatus).sort()).toEqual([
      'active',
      'frozen',
      'proposed',
      'rolled_back',
    ]);
  });
  it('DriftDecision has 4 values', () => {
    expect(Object.values(DriftDecision)).toHaveLength(4);
  });
  it('FeatureFlagName.OPERATIONAL_PROFILE_V2 defined', () => {
    expect(FeatureFlagName.OPERATIONAL_PROFILE_V2).toBe('OPERATIONAL_PROFILE_V2');
  });
  it('featureFlags singleton respects FEATURE_OPERATIONAL_PROFILE_V2 default off', () => {
    expect(featureFlags.isEnabled(FeatureFlagName.OPERATIONAL_PROFILE_V2)).toBe(false);
  });
});
