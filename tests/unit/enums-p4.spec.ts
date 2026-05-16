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
  // P4 baseline: 7 detectores (tom, valores, confianca, vies, escopo, linguagem, procedimento).
  // P8d adicionou PAPEL_DRIFT (8º). P8b vai adicionar SOUL_DRIFT (9º quando merge).
  it('DriftType has 8 values (P4 baseline + P8d papel_drift)', () => {
    expect(Object.values(DriftType)).toHaveLength(8);
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
