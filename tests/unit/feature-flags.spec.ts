import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

describe('FeatureFlags', () => {
  let flags: FeatureFlags;

  beforeEach(() => {
    flags = new FeatureFlags({
      [FeatureFlagName.MULTI_CHANNEL]: false,
    });
  });

  it('retorna valor da configuração inicial', () => {
    expect(flags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(false);
  });

  it('permite override em runtime', () => {
    flags.override(FeatureFlagName.MULTI_CHANNEL, true);
    expect(flags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(true);
  });

  it('kill switch desliga flag mesmo se override true', () => {
    flags.override(FeatureFlagName.MULTI_CHANNEL, true);
    flags.killSwitch(FeatureFlagName.MULTI_CHANNEL);
    expect(flags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(false);
  });

  it('reset limpa overrides e kill switches', () => {
    flags.override(FeatureFlagName.MULTI_CHANNEL, true);
    flags.reset();
    expect(flags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(false);
  });
});
