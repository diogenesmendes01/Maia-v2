/**
 * P8a — FEATURE_CONTEXT_PACKET_V1 flag + kill switch.
 *
 * Plan Task 14. Default OFF so the new Context Packet path doesn't run in
 * production until explicitly enabled per tenant or globally.
 *
 * Precedence (highest first):
 *   1. FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH=true  → always OFF
 *   2. Tenant override                              → reserved (P8d rollout)
 *   3. FEATURE_CONTEXT_PACKET_V1=true               → ON globally
 *   4. Default                                       → OFF
 */

export interface ContextPacketFlagSource {
  /** Per-tenant override (P8d). null means "no override, fall through". */
  getTenantOverride?(tenant_id: string): Promise<boolean | null>;
  /** Read env vars. Default reads process.env. */
  getEnv?(name: string): string | undefined;
}

const defaultSource: ContextPacketFlagSource = {
  async getTenantOverride() {
    return null;
  },
  getEnv(name) {
    return process.env[name];
  },
};

export async function isContextPacketV1Enabled(
  tenant_id: string,
  source: ContextPacketFlagSource = defaultSource,
): Promise<boolean> {
  const env = source.getEnv ?? defaultSource.getEnv!;

  // 1. Kill switch — highest precedence, blocks everything
  if (env('FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH') === 'true') {
    return false;
  }

  // 2. Tenant override (P8d rollout). When present, it wins over global env.
  if (source.getTenantOverride) {
    try {
      const override = await source.getTenantOverride(tenant_id);
      if (override !== null && override !== undefined) {
        return override;
      }
    } catch {
      // Override source failed → fall through to global env (safe default).
    }
  }

  // 3. Global env flag
  if (env('FEATURE_CONTEXT_PACKET_V1') === 'true') {
    return true;
  }

  // 4. Default OFF
  return false;
}
