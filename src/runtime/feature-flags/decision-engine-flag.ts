/**
 * P9b — FEATURE_DECISION_ENGINE_V1 flag.
 *
 * Spec §12: governance contract for canary rollout of Decision Engine v1.
 *
 * Resolution order (first match wins):
 *   1. `FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true` → always false
 *   2. tenant override table (TODO: P11 will provide canary rollout table)
 *   3. `FEATURE_DECISION_ENGINE_V1=true` → true (global ON)
 *   4. default false
 *
 * INVARIANTE 14 (spec §12.2): this flag controls ONLY whether the Decision
 * Engine V1 produces the DecisionPacket. PEPs run regardless — the legacy
 * path runs a thin wrapper that still triggers Early/Mid/Late checks.
 */

export interface TenantFeatureFlagsRepo {
  /**
   * Returns the tenant-specific override for the flag, or `null` if no
   * override is set.
   */
  getOverride(tenant_id: string, flag_name: string): Promise<boolean | null>;
}

export interface DecisionEngineFlagDeps {
  env?: NodeJS.ProcessEnv;
  tenantFeatureFlagsRepo?: TenantFeatureFlagsRepo;
}

export async function isDecisionEngineV1Enabled(
  tenant_id: string,
  deps: DecisionEngineFlagDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;

  // 1. kill switch
  if (env.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH === 'true') {
    return false;
  }

  // 2. tenant override (canary rollout)
  if (deps.tenantFeatureFlagsRepo) {
    try {
      const override = await deps.tenantFeatureFlagsRepo.getOverride(
        tenant_id,
        'decision_engine_v1',
      );
      if (override !== null) return override;
    } catch {
      // Repo read errors must not break flag resolution — fall through.
    }
  }

  // 3. global env flag
  if (env.FEATURE_DECISION_ENGINE_V1 === 'true') {
    return true;
  }

  // 4. default OFF
  return false;
}
