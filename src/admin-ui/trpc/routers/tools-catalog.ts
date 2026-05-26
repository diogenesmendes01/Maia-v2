/**
 * Admin UI — Tools Catalog router (read-only).
 *
 * Surfaces every tool the LLM can call so operators can answer "what can
 * Maia do, and how?". Tools are defined in code (`src/tools/_registry.ts`),
 * global (not tenant-scoped), so this needs no tenant context — visible to
 * any authenticated role (`protectedProcedure`).
 *
 * THE IMPORT-COST / SERVER-ONLY BOUNDARY (spec §1.2, critical):
 *   `import { REGISTRY } from '@/tools/_registry.js'` pulls in EVERY tool
 *   handler and, transitively, the DB repos / LLM clients they import. That
 *   must never reach client code. We therefore import the registry (and the
 *   schema introspector) via a DYNAMIC import INSIDE the procedure body — the
 *   tRPC server already runs backend code, and the client only ever receives
 *   the serialized JSON returned here. The `/tools` page imports nothing from
 *   `@/tools/*`; it consumes this query's output only.
 *
 * Richer than `getToolSchemas()` (`_registry.ts`): that helper returns a
 * stubbed `input_schema: { type:'object', additionalProperties:true }` and is
 * filtered by LLM permission logic. A catalog wants the FULL set (including
 * tools disabled by an off feature flag, so operators see what exists and
 * which flag turns it on) plus an expanded input field list (`describeZodObject`).
 */
import { router, protectedProcedure } from '../server.js';

export const toolsCatalogRouter = router({
  /**
   * listCatalog — every registered tool with metadata + an `enabled` flag.
   *
   * Read-only; no tenant scoping (tools are global). Returns the full
   * registry (NOT filtered by `getToolSchemas` permission logic) so the UI
   * can render disabled-but-existing tools and name the gating feature flag.
   */
  listCatalog: protectedProcedure.query(async () => {
    // Dynamic, server-only import — see the server-only boundary note above.
    const { REGISTRY, isToolEnabled } = await import('@/tools/_registry.js');
    const { describeZodObject } = await import('@/tools/describe-schema.js');

    return Object.values(REGISTRY).map((t) => ({
      name: t.name,
      description: t.description,
      side_effect: t.side_effect, // none | read | write | communication
      operation_type: t.operation_type,
      sensitive: t.sensitive ?? false, // view-once outputs (balances etc.)
      feature_flag: t.feature_flag ?? null,
      required_actions: [...t.required_actions],
      enabled: isToolEnabled(t.name), // false when its feature flag is off
      inputs: describeZodObject(t.input_schema), // [{ name, type, optional }]
    }));
  }),
});
