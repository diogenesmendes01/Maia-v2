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
  it('#411: FeatureFlagName.MULTI_CHANNEL removed (channel resolution is always-on via single-tenant catch-all)', () => {
    expect((FeatureFlagName as Record<string, string>)['MULTI_CHANNEL']).toBeUndefined();
    // #412 removed COGNITIVE_GRAPH too (the cognitive graph runs
    // unconditionally), so the FeatureFlagName enum is now empty. The
    // FeatureFlags singleton still instantiates and defaults absent flags to
    // false (kept as the registration point for the next phase's flag).
    expect((FeatureFlagName as Record<string, string>)['COGNITIVE_GRAPH']).toBeUndefined();
    // #478 registered the next phase's flag (MCP_TOOLS, default OFF) — the
    // enum is no longer empty; the removed legacy flags stay removed.
    expect(Object.keys(FeatureFlagName)).toEqual(['MCP_TOOLS']);
    expect(
      featureFlags.isEnabled('ANY_ABSENT_FLAG' as unknown as never),
    ).toBe(false);
  });
});
