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

/**
 * Codex round 3 on PR #188 [P2]: provider gate. The active provider
 * (env LLM_PROVIDER) decides which slugs are runtime-callable:
 *
 *   - `openrouter`: any slug is valid; the OpenRouter API accepts the
 *     `<vendor>/<model>` form and routes to the matching upstream.
 *   - `anthropic`: only Anthropic-native slugs work, because
 *     `AnthropicProvider.callLLM` passes the slug straight to the SDK,
 *     and `openai/gpt-5` (or `x-ai/grok-4.1-fast`) is not a valid
 *     Anthropic model ID. The SDK rejects with 404, breaking every
 *     runtime LLM call until a founder switches back.
 *
 * We accept slugs that EITHER start with `anthropic/` (OpenRouter-style
 * canonical form) OR have no slash at all (Anthropic native short IDs
 * like `claude-sonnet-4-6`). Slugs starting with any other vendor
 * prefix (`openai/`, `x-ai/`, `google/`, etc.) are rejected when
 * `LLM_PROVIDER=anthropic`.
 *
 * The check runs at the router boundary (NOT zod, because it needs the
 * runtime config). A future provider could be added with no schema
 * change — just extend the switch.
 */
function isSlugCompatible(
  slug: string,
  provider: 'anthropic' | 'openrouter',
): boolean {
  if (provider === 'openrouter') return true;
  if (provider === 'anthropic') {
    if (slug.startsWith('anthropic/')) return true;
    // Anthropic native short ID (no vendor prefix): no slash.
    if (!slug.includes('/')) return true;
    return false;
  }
  // Unknown provider: be permissive — config validation upstream should
  // catch this before we ever reach the router.
  return true;
}

const UpdateInputSchema = z.object({
  // Both required: operators must always set both explicitly so an incident
  // switch can't accidentally leave one side on the broken provider. Pass
  // the same value back to "keep it unchanged" — the audit row will record
  // that as a no-op for that side (see logic below).
  main: ModelSlugSchema,
  fast: ModelSlugSchema,
  // Codex round 3 on PR #188 [P2]: optimistic concurrency control. Two
  // founders loading the page from the same snapshot, where founder B
  // changes ONLY the `fast` side but submits the stale `main` along
  // with it, would silently revert founder A's `main` commit. The
  // expected_* fields carry the values the founder OBSERVED at load
  // time; the server compares them against the locked current values
  // INSIDE the tx and refuses the write if anything moved underneath
  // — the UI then prompts the founder to refresh and re-decide. This
  // is the same pattern as `If-Match` / ETag in HTTP and the same
  // pattern `tenantsRepo.updateStatusAtomic` uses for its expected_
  // status field.
  //
  // Both are required so a founder can't accidentally skip the lock by
  // omitting them. To bypass intentionally (e.g. emergency override
  // when the UI is stuck), the operator passes whatever it currently
  // sees — there's no special "skip lock" sentinel because the cost of
  // a wrong override during an incident outweighs the convenience.
  expected_main: ModelSlugSchema,
  expected_fast: ModelSlugSchema,
  // Codex round 2 on PR #188 [P3]: the previous schema validated the raw
  // character count, so a 10-space comment passed validation and the
  // audit row would record a forensically-useless reason. `.trim()` runs
  // BEFORE `.min(10)` so whitespace-only comments are rejected at the
  // server (the audit boundary), not just at the UI which already trims.
  comment: z
    .string()
    .trim()
    .min(10, 'comment must be at least 10 non-whitespace characters')
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
   *
   * Codex round 3 on PR #188 [P2]: filter the catalog by the active
   * provider so the UI doesn't offer slugs the runtime can't actually
   * use. With `LLM_PROVIDER=anthropic`, callLLM passes the stored slug
   * straight to AnthropicProvider, so `openai/gpt-5` etc. would break
   * every runtime call. The server-side validation in `update` is the
   * source of truth (don't trust the client to filter); this catalog
   * filter exists to spare the operator from selecting a doomed option
   * in the first place. Returns the full set when provider=openrouter.
   */
  catalog: founderProcedure.query(async () => {
    const all = await getToolCallingModels();
    const env = envDefaults();
    const provider = env.provider as 'anthropic' | 'openrouter';
    const items =
      provider === 'openrouter'
        ? all
        : all.filter((m) => isSlugCompatible(m.id, provider));
    return { items, provider };
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

      // Codex round 3 on PR #188 [P2]: provider gate (server-side
      // source of truth). The UI filters the catalog by provider, but
      // we can't trust the client — a stale tab, a freshly-changed
      // LLM_PROVIDER env, or a hand-crafted tRPC call could still
      // submit an incompatible slug. Reject here BEFORE the audited
      // write so we never persist a slug that the runtime can't call.
      const provider = env.provider as 'anthropic' | 'openrouter';
      for (const [field, slug] of [
        ['main', input.main],
        ['fast', input.fast],
      ] as const) {
        if (!isSlugCompatible(slug, provider)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `${field}=${slug} is incompatible with the active LLM provider (${provider}). ` +
              (provider === 'anthropic'
                ? 'Anthropic provider accepts only anthropic/* or unprefixed Anthropic-native slugs.'
                : `Provider ${provider} does not accept this slug.`),
          });
        }
      }

      const result = await setGlobalLLMSettingsAtomic({
        main: input.main,
        fast: input.fast,
        expected_main: input.expected_main,
        expected_fast: input.expected_fast,
        updated_by: ctx.userId,
        actor_role: ctx.userRole,
        tenant_id: ctx.tenantId,
        comment: input.comment,
      });

      if (!result.ok) {
        // Codex round 3 on PR #188 [P2]: optimistic-conflict path. The
        // UI surfaces the current/expected mismatch so the founder can
        // refresh, see the new state, and re-decide.
        if (result.reason === 'optimistic_conflict') {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `Settings changed concurrently — refresh and try again. ` +
              `field=${result.field} expected=${result.expected ?? '(unset)'} current=${result.current ?? '(unset)'}`,
          });
        }
        if (result.reason === 'no_changes') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'No changes — both main and fast already match the requested models',
          });
        }
        // Exhaustive narrowing — both failure variants handled above.
        // If a third variant is added to setGlobalLLMSettingsAtomic in
        // the future, this assignment will fail compile and force the
        // operator to update the router.
        const _exhaustive: never = result;
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
