import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

describe('FeatureFlags', () => {
  let flags: FeatureFlags;

  beforeEach(() => {
    flags = new FeatureFlags({
      [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: false,
    });
  });

  it('retorna valor da configuração inicial', () => {
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });

  it('permite override em runtime', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(true);
  });

  it('kill switch desliga flag mesmo se override true', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    flags.killSwitch(FeatureFlagName.P0_TENANT_GUARD_ENFORCED);
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });

  it('reset limpa overrides e kill switches', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    flags.reset();
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });
});
