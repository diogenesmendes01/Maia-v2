import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlags } from '@/config/feature-flags.js';
import type { FeatureFlagName } from '@/types/enums.js';

// After #411 (MULTI_CHANNEL) and #412 (COGNITIVE_GRAPH) both removed their
// toggles, the FeatureFlagName enum is intentionally empty. The FeatureFlags
// class survives as the registration point for the next phase's flag, so this
// spec proves the mechanics still hold without referencing any concrete flag.
// `FeatureFlagName` is now `never`, so callsites that exercise the runtime
// (string-keyed) behavior use a cast — vitest strips types, and at runtime the
// class keys off plain strings.
const ABSENT = 'ANY_ABSENT_FLAG' as unknown as FeatureFlagName;

describe('FeatureFlags', () => {
  let flags: FeatureFlags;

  beforeEach(() => {
    flags = new FeatureFlags({});
  });

  it('instancia com configuração inicial vazia', () => {
    expect(flags).toBeInstanceOf(FeatureFlags);
  });

  it('flag não configurada cai no default false', () => {
    expect(flags.isEnabled(ABSENT)).toBe(false);
  });

  it('permite override em runtime', () => {
    flags.override(ABSENT, true);
    expect(flags.isEnabled(ABSENT)).toBe(true);
    flags.override(ABSENT, false);
    expect(flags.isEnabled(ABSENT)).toBe(false);
  });

  it('kill switch desliga flag mesmo se override true', () => {
    flags.override(ABSENT, true);
    flags.killSwitch(ABSENT);
    expect(flags.isEnabled(ABSENT)).toBe(false);
  });

  it('reset limpa overrides e kill switches', () => {
    flags.override(ABSENT, true);
    flags.killSwitch(ABSENT);
    flags.reset();
    // Back to the initial (empty) config → default false.
    expect(flags.isEnabled(ABSENT)).toBe(false);
  });
});
