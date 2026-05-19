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
  [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: config.FEATURE_P0_TENANT_GUARD_ENFORCED,
  [FeatureFlagName.OPERATIONAL_PROFILE_V2]: config.FEATURE_OPERATIONAL_PROFILE_V2,
  [FeatureFlagName.DIALOGICAL_ACQUISITION]: config.FEATURE_DIALOGICAL_ACQUISITION,
  [FeatureFlagName.MULTI_CHANNEL]: config.FEATURE_MULTI_CHANNEL,
  [FeatureFlagName.COGNITIVE_GRAPH]: config.FEATURE_COGNITIVE_GRAPH,
  [FeatureFlagName.CALENDAR_V2]: config.FEATURE_CALENDAR_V2,
  [FeatureFlagName.P8C_USER_LAYER_NAMESPACE_V1]: config.FEATURE_P8C_USER_LAYER_NAMESPACE_V1,
  [FeatureFlagName.FEATURE_SOUL_LAYER_V1]: config.FEATURE_SOUL_LAYER_V1,
  [FeatureFlagName.POLICY_RESOLVER_V1]: config.FEATURE_POLICY_RESOLVER_V1,
  [FeatureFlagName.SKILL_REGISTRY_V1]: config.FEATURE_SKILL_REGISTRY_V1,
  [FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1]: config.FEATURE_KNOWLEDGE_STATE_MACHINE_V1,
  [FeatureFlagName.RUNTIME_TRACE_V1]: config.FEATURE_RUNTIME_TRACE_V1,
});

/**
 * P10a — Knowledge State Machine feature flag, exposed as named constant
 * for module-level early-returns (workers, tool registration).
 */
export const FEATURE_KNOWLEDGE_STATE_MACHINE_V1 =
  config.FEATURE_KNOWLEDGE_STATE_MACHINE_V1;
