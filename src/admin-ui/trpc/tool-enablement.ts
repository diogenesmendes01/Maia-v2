/**
 * Admin UI — shared, IMPORT-SAFE tool-enablement helper (PR #213 round-2 FIX B).
 *
 * A tool's gating `feature_flag` (carried in the generated tool catalog as a
 * plain string, or null) is resolved to a live boolean using the SAME gate the
 * runtime DISPATCHER uses (`src/tools/_dispatcher.ts` → `_registry.isToolEnabled`):
 *
 *   - Declared `FeatureFlagName` flags are read through the runtime
 *     `featureFlags.isEnabled()` singleton, so KILL SWITCHES and runtime
 *     OVERRIDES are honoured — exactly like the dispatcher. Reading static
 *     `config.FEATURE_*` here would DIVERGE from the dispatcher: a flag killed
 *     at runtime stays "on" in config, so `propose` would accept a tool the
 *     dispatcher refuses to run.
 *   - Env-var-name flags (`FEATURE_PDF_REPORTS`) gate the tool's *presence in
 *     `REGISTRY`* via a conditional spread at module load — they are NOT members
 *     of `FeatureFlagName` and have no runtime override path, so the dispatcher
 *     itself only sees them via `config`. We mirror that by reading
 *     `config.FEATURE_*` for these.
 *   - No gating flag (null) → always enabled. PR #406 collapsed the KSM
 *     `propose_*`, calendar and scheduling tools to UNCONDITIONALLY enabled and
 *     removed their gating flags, so the generated catalog now carries
 *     `feature_flag: null` for them and they resolve to ENABLED here.
 *   - An unknown flag name conservatively reads as DISABLED (a generator/router
 *     drift bug, surfaced by treating the tool as off rather than silently on).
 *
 * IMPORT SAFETY (PR #207 critical, re-verified round-2): this module imports
 * ONLY `@/config/env` (zod validation; side-effect-free) and
 * `@/config/feature-flags` (the `featureFlags` singleton). The feature-flags
 * module's transitive imports are `@/types/enums` (pure literal maps, zero
 * imports) and `@/config/env` (zod + dotenv config load + a pure path-validation
 * import) — NO tool handlers, NO gateway, NO timers/Redis/BullMQ. It is
 * therefore the SAME import-cost class as `tools-catalog.ts` (which already
 * imports `config` directly). Do NOT import the registry or any tool handler
 * here, or the gateway side-effects PR #207 removed return.
 *
 * CROSS-CONTAINER CAVEAT: admin-ui and maia-app run in SEPARATE processes, each
 * with its OWN in-memory `featureFlags` singleton (overrides/kill switches are
 * per-process; see `FeatureFlags` in `@/config/feature-flags`). A runtime
 * override set on maia-app is NOT visible to this admin-ui process. Reading
 * `featureFlags.isEnabled()` here still matches the dispatch *API* and honours
 * any override applied IN admin-ui's own process; it is the closest correct
 * gate available without a shared flag store. (Config-initial values are
 * identical across containers when the env is, so the common case agrees.)
 */
import { config } from '@/config/env.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

/**
 * Env-var-name flags resolved against the static config boolean rather than the
 * runtime `featureFlags` singleton: they gate a tool's PRESENCE in `REGISTRY`
 * via a conditional spread (never were `FeatureFlagName` members).
 *
 * PR #406: `calendar_v2` / `KNOWLEDGE_STATE_MACHINE_V1` / `SKILL_REGISTRY_V1` /
 * `FEATURE_SCHEDULING_V2` were removed when those behaviours collapsed to
 * always-on; the regenerated catalog no longer carries them (their entries are
 * `feature_flag: null` ⇒ enabled). `FEATURE_PDF_REPORTS` (the PRODUCT-gated PDF
 * tool) is the only env-var-name flag that remains. Mirrors `tools-catalog.ts`'s
 * `FLAG_TO_CONFIG`.
 */
const ENV_FLAG_TO_CONFIG: Readonly<Record<string, boolean>> = {
  FEATURE_PDF_REPORTS: config.FEATURE_PDF_REPORTS,
};

/** The set of valid `FeatureFlagName` VALUES, for the runtime-vs-env decision. */
const FEATURE_FLAG_VALUES: ReadonlySet<string> = new Set(
  Object.values(FeatureFlagName),
);

/**
 * Whether a catalog tool is currently enabled, given its gating flag NAME.
 * Mirrors the dispatcher's `isToolEnabled`: runtime `featureFlags.isEnabled()`
 * for declared `FeatureFlagName` flags (kill switches / overrides honoured),
 * static config for env-var-name flags, always-on when ungated, conservative
 * off for an unknown flag.
 */
export function isToolEnabledByFlag(feature_flag: string | null): boolean {
  if (feature_flag === null) return true;
  // Declared FeatureFlagName → runtime gate (same path as the dispatcher).
  if (FEATURE_FLAG_VALUES.has(feature_flag)) {
    return featureFlags.isEnabled(feature_flag as FeatureFlagName);
  }
  // Env-var-name flag (REGISTRY presence gate) → static config.
  return ENV_FLAG_TO_CONFIG[feature_flag] ?? false;
}
