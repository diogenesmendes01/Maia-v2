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
  // P6 — separação Agent/Channel/Role + Role Policy. Gates channel resolution
  // (channel-resolver / baileys jid resolver); removing it breaks prod.
  [FeatureFlagName.MULTI_CHANNEL]: config.FEATURE_MULTI_CHANNEL,
  // P7 — grafo cognitivo formal (partial). Gates the cognitive-graph path in
  // agent/core.ts; removing it breaks prod.
  [FeatureFlagName.COGNITIVE_GRAPH]: config.FEATURE_COGNITIVE_GRAPH,
});
