import { FeatureFlagName } from '@/types/enums.js';

/**
 * Framework de feature flags com 3 níveis de override:
 * 1. Configuração inicial (env vars)
 * 2. Override em runtime (dashboard, testes)
 * 3. Kill switch (override forçado em false; precedência máxima)
 */
export class FeatureFlags {
  private overrides = new Map<FeatureFlagName, boolean>();
  private kills = new Set<FeatureFlagName>();

  constructor(private initial: Partial<Record<FeatureFlagName, boolean>>) {}

  isEnabled(name: FeatureFlagName): boolean {
    if (this.kills.has(name)) return false;
    if (this.overrides.has(name)) return this.overrides.get(name)!;
    return this.initial[name] ?? false;
  }

  override(name: FeatureFlagName, value: boolean): void {
    this.overrides.set(name, value);
  }

  killSwitch(name: FeatureFlagName): void {
    this.kills.add(name);
  }

  unkillSwitch(name: FeatureFlagName): void {
    this.kills.delete(name);
  }

  reset(): void {
    this.overrides.clear();
    this.kills.clear();
  }
}

// Instância singleton lida do config
import { config } from './env.js';

export const featureFlags = new FeatureFlags({
  // No active feature flags. Both former entries are gone:
  //   - P7 COGNITIVE_GRAPH removed in #412 (the cognitive graph runs
  //     unconditionally — parity with the imperative path was proven).
  //   - P6 MULTI_CHANNEL removed in #411 (channel resolution now resolves any
  //     inbound sender to (default, default) via the single-tenant catch-all in
  //     src/gateway/channel-resolver.ts, so the toggle is always-on / gone).
  // The FeatureFlags class + (now-empty) FeatureFlagName enum survive as the
  // registration point for the next phase's flag; deleting them is a separate
  // follow-up.
});
