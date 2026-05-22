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
  getCurrentLLMSettings,
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
 *   - `anthropic`: only Anthropic-NATIVE slugs work, because
 *     `AnthropicProvider.callLLM` passes the slug straight to
 *     `messages.create({ model })`. The Anthropic SDK accepts IDs like
 *     `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` — NEVER the
 *     OpenRouter-prefixed form `anthropic/claude-sonnet-4.6`.
 *
 * Codex round 4 on PR #188 [high]: the previous gate ALSO accepted
 * `anthropic/*` slugs in Anthropic mode, on the theory that the
 * OpenRouter canonical form was harmless. That was wrong: the runtime
 * never strips the prefix or normalizes the dots-vs-hyphens (the
 * Anthropic native form replaces `.` with `-`), so the SDK rejected
 * every call. We now require Anthropic-native form ONLY: no slash, no
 * vendor prefix, lower-case alphanumerics + dashes. The catalog
 * route hides incompatible items in anthropic mode (see `catalog`).
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
    // Codex round 4 [high]: Anthropic native short IDs ONLY. No slash
    // means no vendor prefix; the AnthropicProvider passes the slug
    // straight to the SDK so it MUST be a real Anthropic model ID
    // (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, etc.).
    if (slug.includes('/')) return false;
    // Native IDs: lower-case letters/digits/hyphens only. The SDK is
    // strict about format — reject anything with dots, underscores, or
    // upper-case to avoid persisting a typo that the runtime would
    // then 404 on.
    return /^[a-z0-9-]+$/.test(slug);
  }
  // Unknown provider: be permissive — config validation upstream should
  // catch this before we ever reach the router.
  return true;
}

/**
 * Codex round 4 on PR #188 [high]: best-effort normalization of an
 * OpenRouter-style anthropic slug into the Anthropic-native short ID
 * the SDK expects. We use this in the catalog filter so the operator
 * sees a meaningful list in Anthropic mode without us hiding every
 * entry (the OpenRouter API returns its anthropic items in
 * `anthropic/claude-sonnet-4.6` form, but the Anthropic SDK needs
 * `claude-sonnet-4-6`). Conservative: only normalize when the result
 * passes `isSlugCompatible` (`/^[a-z0-9-]+$/`). On any ambiguity we
 * drop the item rather than guess.
 */
function normalizeAnthropicSlug(slug: string): string | null {
  if (!slug.startsWith('anthropic/')) return null;
  const tail = slug.slice('anthropic/'.length);
  // Map `.` → `-` (OpenRouter uses `claude-sonnet-4.6`; Anthropic SDK
  // uses `claude-sonnet-4-6`). Drop anything that still doesn't pass
  // the native-format check.
  const candidate = tail.replace(/\./g, '-');
  return /^[a-z0-9-]+$/.test(candidate) ? candidate : null;
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
  // — the UI then prompts the founder to refresh and re-decide.
  //
  // Codex round 4 on PR #188 [high]: nullable. On a fresh install with
  // no global_settings rows, getCurrentLLMSettings reports source='env'
  // (or 'legacy') and the UI passes `null` to mean "I did not observe
  // a global_settings row". The repo's compare path treats locked
  // null + expected null as a match, so the first-ever update goes
  // through instead of looping forever on optimistic_conflict. Both
  // are required (no implicit skip) — the UI must explicitly state
  // what it saw.
  expected_main: ModelSlugSchema.nullable(),
  expected_fast: ModelSlugSchema.nullable(),
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
   * No tenant context wrap: getCurrentLLMSettings reads from
   * `global_settings` (process-wide), which is NOT scoped to
   * tenant/agent.
   *
   * Codex round 4 on PR #188 [high]: surface `source` per side so the
   * UI knows whether the displayed value comes from `global_settings`
   * ('global'), the legacy `agent_facts` fallback ('legacy'), or the
   * env default ('env'). The UI maps source !== 'global' → `null`
   * when building `expected_*` for the next mutation — that way the
   * first-ever update on a fresh install doesn't infinite-loop on
   * optimistic_conflict.
   *
   * Top-level `main` / `fast` keep returning the string value so
   * existing consumers (tests, older UI snapshots) don't break.
   */
  get: founderProcedure.query(async () => {
    const settings = await getCurrentLLMSettings();
    const env = envDefaults();
    return {
      main: settings.main.value,
      fast: settings.fast.value,
      // Codex round 4 [high]: source flags consumed by the UI to
      // decide whether expected_* should be the observed value or
      // null. Tests assert the shape of this struct.
      mainSource: settings.main.source,
      fastSource: settings.fast.source,
      env,
    };
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
   * straight to AnthropicProvider.
   *
   * Codex round 4 on PR #188 [high]: in Anthropic mode the OpenRouter
   * catalog lists Anthropic items in `anthropic/claude-sonnet-4.6`
   * form — but the AnthropicProvider needs `claude-sonnet-4-6` (no
   * prefix, hyphens not dots). We now NORMALIZE OpenRouter entries
   * to native Anthropic IDs in Anthropic mode: any item whose slug
   * starts with `anthropic/` is rewritten via `normalizeAnthropicSlug`
   * and re-emitted with the native ID; items from other vendors are
   * dropped entirely (the runtime cannot call them). The server-side
   * `update` validation remains the source of truth, but the catalog
   * filter spares the operator from selecting a doomed option in the
   * first place. Returns the full unfiltered set when
   * provider=openrouter.
   */
  catalog: founderProcedure.query(async () => {
    const all = await getToolCallingModels();
    const env = envDefaults();
    const provider = env.provider as 'anthropic' | 'openrouter';
    if (provider === 'openrouter') {
      return { items: all, provider };
    }
    // provider === 'anthropic'. Normalize anthropic/* slugs to native
    // short IDs; drop anything else. Items already in native form
    // (no slash) pass straight through.
    const items = all.flatMap((m) => {
      if (isSlugCompatible(m.id, 'anthropic')) {
        return [m];
      }
      const native = normalizeAnthropicSlug(m.id);
      if (native && isSlugCompatible(native, 'anthropic')) {
        return [{ ...m, id: native }];
      }
      return [];
    });
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
                ? // Codex round 4 [high]: Anthropic mode requires the
                  // SDK-native short ID (no slash, no vendor prefix —
                  // e.g. `claude-sonnet-4-6`). OpenRouter-formatted
                  // slugs like `anthropic/claude-sonnet-4.6` are
                  // rejected because the runtime passes the value
                  // straight to messages.create() and the SDK rejects
                  // anything that isn't a native ID.
                  'Anthropic provider requires the SDK-native short ID (e.g. claude-sonnet-4-6 — no slash, no vendor prefix). OpenRouter-style slugs like anthropic/claude-sonnet-4.6 are not accepted.'
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
