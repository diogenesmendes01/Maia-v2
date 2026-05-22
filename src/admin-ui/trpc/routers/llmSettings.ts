/**
 * Admin UI — LLM settings router.
 *
 * Replaces the GET/POST `/dashboard/llm-settings` handlers from the legacy
 * Fastify dashboard (`src/dashboard/index.ts`, removed by PR #176). Those
 * handlers were the ONLY UI control for `setCurrentMainModel` /
 * `setCurrentFastModel` — an incident-response surface (Anthropic outage,
 * model deprecation, mid-deploy regression) that operators relied on to
 * switch the runtime model live, no redeploy.
 *
 * Procedures:
 *   - get      — current main/fast model + env defaults + provider
 *                (founder-only; the model switch UI itself is founder-gated,
 *                and this query backs that UI, so we keep the gate consistent).
 *   - catalog  — OpenRouter tool-calling-capable model list (cached 1 h).
 *                Founder-only for the same reason as `get`.
 *   - update   — flips `llm.model.main` / `llm.model.fast` AND appends an
 *                `admin_audit_log` row, both inside a single `withTx`,
 *                with `SELECT ... FOR UPDATE` on each global_settings row
 *                — Codex round 1 on PR #188 made this atomic so concurrent
 *                founders can't corrupt the audit trail (medium) and the
 *                storage is process-global so every tenant's next ReAct
 *                turn sees the new model (high).
 *
 * Storage scope (issue #183, Codex round 1 on PR #188, [high]):
 *   This router writes to `global_settings` (process-wide singleton), NOT
 *   `agent_facts`. The old storage was silently scoped to the founder's
 *   `(tenant_id, agent_id='default')` row — any non-default agent or any
 *   other tenant kept reading the env model, defeating the incident-time
 *   purpose of this page. The runtime read path (`getCurrentMainModel` /
 *   `getCurrentFastModel`) reads from `global_settings` too, so a founder
 *   change here is visible to EVERY agent's next call.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, founderProcedure } from '../server.js';
import {
  getCurrentMainModel,
  getCurrentFastModel,
  envDefaults,
  setGlobalLLMSettingsAtomic,
} from '../../../lib/llm-settings.js';
import { getToolCallingModels } from '../../../lib/openrouter-models.js';

const KEY_MAIN = 'llm.model.main';
const KEY_FAST = 'llm.model.fast';

// Model slugs are vendor-provided (`anthropic/claude-sonnet-4.6`,
// `openai/gpt-5`, `x-ai/grok-4.1-fast`, etc.). Keep the validation
// permissive (any printable chars, capped at 200 — same cap the legacy
// dashboard enforced) so operators can paste a freshly-published slug
// not yet in the OpenRouter catalog.
const ModelSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._\-/:]+$/,
    'must contain only letters, digits, dot, underscore, hyphen, slash, or colon',
  );

const UpdateInputSchema = z.object({
  // Both required: operators must always set both explicitly so an incident
  // switch can't accidentally leave one side on the broken provider. Pass
  // the same value back to "keep it unchanged" — the audit row will record
  // that as a no-op for that side (see logic below).
  main: ModelSlugSchema,
  fast: ModelSlugSchema,
  comment: z
    .string()
    .min(10, 'comment must be at least 10 characters')
    .max(1000, 'comment must be at most 1000 characters'),
});

export const llmSettingsRouter = router({
  /**
   * Read current main+fast model along with env defaults and provider.
   * No tenant context wrap: `getCurrentMainModel`/`getCurrentFastModel`
   * now read from `global_settings` (process-wide), which is NOT scoped
   * to tenant/agent.
   */
  get: founderProcedure.query(async () => {
    const [main, fast] = await Promise.all([
      getCurrentMainModel(),
      getCurrentFastModel(),
    ]);
    const env = envDefaults();
    return { main, fast, env };
  }),

  /**
   * OpenRouter tool-calling-capable model catalog. Cached 1h in-memory in
   * `getToolCallingModels` (see `src/lib/openrouter-models.ts`); on
   * network failure or first-call timeout, returns a curated fallback
   * list so the UI stays usable mid-Anthropic-outage.
   */
  catalog: founderProcedure.query(async () => {
    const items = await getToolCallingModels();
    return { items };
  }),

  /**
   * Atomic update: writes both model rows + audit row inside one withTx
   * with `SELECT ... FOR UPDATE` per global_settings key (Codex round 1
   * on PR #188, [medium]). The previous implementation read current
   * values OUTSIDE the tx then conditional-skipped writes based on that
   * stale snapshot, so two concurrent founders could land an audit row
   * whose `before` claimed one value but `after` reflected the other
   * founder's write. The new path reads-then-writes under the lock, so
   * the audit row sees exactly what persisted.
   *
   * Returns `{ ok: true, applied_at, before, after }` — before is the
   * REAL pre-lock value (not the router's pre-tx read). If neither side
   * changed, throws BAD_REQUEST (no DB writes, no audit row).
   *
   * Note: `before.main` / `before.fast` can be null if the key was never
   * set (fresh DB — runtime was on the env default). The router maps
   * null → the env default for the UI's convenience.
   */
  update: founderProcedure
    .input(UpdateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const env = envDefaults();
      const result = await setGlobalLLMSettingsAtomic({
        main: input.main,
        fast: input.fast,
        updated_by: ctx.userId,
        actor_role: ctx.userRole,
        tenant_id: ctx.tenantId,
        comment: input.comment,
      });

      if (!result.ok) {
        // Exhaustive narrowing: only one failure reason today.
        if (result.reason === 'no_changes') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'No changes — both main and fast already match the requested models',
          });
        }
        const _exhaustive: never = result.reason;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `llmSettings.update unknown failure: ${String(_exhaustive)}`,
        });
      }

      // Surface env defaults for null-before slots so the UI doesn't have
      // to do a second round-trip to render the "Previously" line.
      return {
        ok: true as const,
        applied_at: result.applied_at,
        before: {
          main: result.before.main ?? env.main,
          fast: result.before.fast ?? env.fast,
        },
        after: result.after,
      };
    }),
});

// Test seam: exported so the router-level test can re-use the validation
// schema for input-shape assertions without importing zod directly.
export const _internal = {
  UpdateInputSchema,
  ModelSlugSchema,
  KEY_MAIN,
  KEY_FAST,
};
