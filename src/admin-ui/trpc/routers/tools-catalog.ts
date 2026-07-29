/**
 * Admin UI — Tools Catalog router (read-only).
 *
 * Surfaces every tool the LLM can call so operators can answer "what can
 * Maia do, and how?". Tools are defined in code (`src/tools/_registry.ts`),
 * global (not tenant-scoped), so this needs no tenant context — visible to
 * any authenticated role (`protectedProcedure`).
 *
 * THE IMPORT-COST / SERVER-ONLY BOUNDARY (PR #207, critical):
 *   This router must import ZERO tool-handler / gateway code. The previous
 *   version `import('@/tools/_registry.js')`-ed at request time, but the
 *   registry transitively imports the gateway:
 *     send-proactive-message → gateway/baileys → gateway/presence
 *       (top-level `setInterval` sweep timer)
 *     send-proactive-message → gateway/queue
 *       (top-level `new IORedis(...)` + `new Queue(...)`)
 *   So the FIRST authenticated `/tools` request installed an orphan presence
 *   timer + a Redis connection + a BullMQ queue inside the admin-ui process.
 *   Lazifying those hot-path gateway modules was rejected as risky.
 *
 *   Instead the catalog is precomputed at build/dev time into a plain-data
 *   artifact (`scripts/gen-tool-catalog.ts` → `../../generated/tool-catalog.ts`)
 *   that this router imports DIRECTLY. That artifact carries the full static
 *   metadata (incl. feature-gated tools + their gating flag NAME + expanded
 *   `inputs` from `describeZodObject`) but pulls in no handlers/gateway. The
 *   only runtime-derived field, `enabled`, is computed here per request from
 *   the live config feature flags — see `isToolEnabled` below.
 *
 *   `@/config/env` is side-effect-free (zod validation only; no timers/Redis)
 *   and the admin-ui already imports it transitively via the DB client.
 *
 * Different from `getToolSchemas()` (`_registry.ts`): that helper returns the
 * canonical JSON Schema the MODEL receives (issue #509, `schema-json.ts`) and is
 * filtered by LLM permission logic. A catalog wants the FULL set (including
 * tools disabled by an off feature flag, so operators see what exists and
 * which flag turns it on) plus a flat, human-readable input field list.
 */
import { router, protectedProcedure } from '../server.js';
import { config } from '@/config/env.js';
import { TOOL_CATALOG } from '../../generated/tool-catalog.js';

/**
 * Map a tool's gating `feature_flag` NAME to its live config boolean.
 *
 * The artifact's `feature_flag` strings are env-var names for the config-gated
 * tools. We map them to the corresponding `config.FEATURE_*` boolean WITHOUT
 * importing the registry, the feature-flags singleton, or any handler. Must
 * cover EVERY flag name that can appear in the generated catalog — see the
 * generator.
 *
 * PR #406: the KSM `propose_*`, calendar and scheduling tools collapsed to
 * UNCONDITIONALLY enabled and lost their gating flags, so the regenerated
 * catalog carries `feature_flag: null` for them (→ enabled). `FEATURE_PDF_REPORTS`
 * (the PRODUCT-gated PDF tool) is the only flag NAME that still appears.
 */
const FLAG_TO_CONFIG: Readonly<Record<string, boolean>> = {
  FEATURE_PDF_REPORTS: config.FEATURE_PDF_REPORTS,
};

/**
 * Whether a catalog tool is currently enabled, given its gating flag name.
 * No gating flag → always enabled. Otherwise read the mapped config boolean;
 * an unknown flag name conservatively reads as disabled (a missing mapping is
 * a generator/router drift bug, surfaced by treating the tool as off).
 */
function isToolEnabled(feature_flag: string | null): boolean {
  if (feature_flag === null) return true;
  return FLAG_TO_CONFIG[feature_flag] ?? false;
}

export const toolsCatalogRouter = router({
  /**
   * listCatalog — every registered tool with metadata + a computed `enabled`.
   *
   * Read-only; no tenant scoping (tools are global). Returns the full catalog
   * (NOT filtered by `getToolSchemas` permission logic) so the UI can render
   * disabled-but-existing tools and name the gating feature flag.
   */
  listCatalog: protectedProcedure.query(() => {
    // Static, gateway-free artifact (see the server-only boundary note above).
    // `enabled` is the ONLY runtime-derived field; everything else is baked in.
    return TOOL_CATALOG.map((entry) => ({
      name: entry.name,
      description: entry.description,
      side_effect: entry.side_effect, // none | read | write | communication
      operation_type: entry.operation_type,
      sensitive: entry.sensitive, // view-once outputs (balances etc.)
      feature_flag: entry.feature_flag, // gating flag NAME or null
      required_actions: entry.required_actions,
      enabled: isToolEnabled(entry.feature_flag), // false when its gating flag is off
      inputs: entry.inputs, // [{ name, type, optional }]
    }));
  }),
});
