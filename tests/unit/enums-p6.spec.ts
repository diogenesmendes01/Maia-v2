import { describe, it, expect } from 'vitest';
import {
  SwitchBehavior, SuggestedBy, DecidedBy, AnnounceMode,
  RoleSelectorStrength, RoleDecisionAction, FeatureFlagName,
} from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

describe('P6 enums', () => {
  it('SwitchBehavior has 4 values', () => {
    expect(Object.values(SwitchBehavior).sort()).toEqual(['by_context', 'free_with_trigger', 'locked', 'prefer_handoff']);
  });
  it('SuggestedBy has 3 values', () => {
    expect(Object.values(SuggestedBy)).toHaveLength(3);
  });
  it('DecidedBy has 4 values (excludes llm_classifier)', () => {
    expect(Object.values(DecidedBy).sort()).toEqual(['fallback_rule', 'owner_override', 'policy_default', 'policy_rule']);
    expect(Object.values(DecidedBy)).not.toContain('llm_classifier');
  });
  it('AnnounceMode has 3 values', () => {
    expect(Object.values(AnnounceMode).sort()).toEqual(['affects_user', 'always', 'never']);
  });
  it('RoleSelectorStrength has 3 values', () => {
    expect(Object.values(RoleSelectorStrength)).toHaveLength(3);
  });
  it('RoleDecisionAction has 4 values', () => {
    expect(Object.values(RoleDecisionAction)).toHaveLength(4);
  });
  it('FeatureFlagName.MULTI_CHANNEL defined', () => {
    expect(FeatureFlagName.MULTI_CHANNEL).toBe('MULTI_CHANNEL');
  });
  it('featureFlags singleton respects FEATURE_MULTI_CHANNEL default off', () => {
    expect(featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(false);
  });
});
