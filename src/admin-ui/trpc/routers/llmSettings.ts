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
 *   - `openrouter`: requires the `<vendor>/<model>` form (round 6
 *     [medium]) because the OpenRouter Chat Completions endpoint 400s
 *     on bare model IDs like `claude-sonnet-4-6`.
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
 * Codex round 5 on PR #188 [P2]: round 4 still accepted ANY lowercase-
 * hyphenated short ID (`gpt-5`, `not-a-model`, ...). That blew up at
 * runtime because AnthropicProvider passes the stored slug straight to
 * `messages.create({ model })`, which 404s on every non-Anthropic slug.
 * Constrain the regex to require the `claude-` prefix. This is
 * conservative — every Anthropic model since 2023 is `claude-*` — and
 * forward-compatible with future Claude families that the SDK accepts
 * directly. Dots ARE allowed in the tail because some published
 * Anthropic IDs use them (e.g. `claude-3.5-sonnet-...`); the SDK
 * accepts both hyphen and dot variants for those.
 *
 * Codex round 6 on PR #188 [medium]: openrouter mode used to accept
 * ANY slug — including bare Anthropic-native IDs like
 * `claude-sonnet-4-6`. OpenRouter's Chat Completions endpoint
 * `chat.completions.create({ model: 'claude-sonnet-4-6' })` 400s with
 * "no such model" because OpenRouter expects the
 * `<vendor>/<model>` form. The gate now requires the vendor/model
 * shape so persistence is rejected at the validation boundary, not
 * at runtime. Vendor segment is lowercase alphanumerics + hyphens;
 * model segment is permissive (a-z0-9.-) to accept future model IDs
 * with dots, hyphens, dashes (e.g. `anthropic/claude-sonnet-4.6`,
 * `openai/gpt-5`, `x-ai/grok-4.1-fast`).
 *
 * Trade-off: if Anthropic ever ships a non-claude-prefixed model ID
 * (no current sign of this), this regex must be updated. A more
 * defensive alternative is an explicit allowlist that we bump per
 * release, but that requires a code change every time Anthropic
 * publishes a new ID. The regex form is the middle ground.
 *
 * The check runs at the router boundary (NOT zod, because it needs the
 * runtime config). A future provider could be added with no schema
 * change — just extend the switch.
 */
function isSlugCompatible(
  slug: string,
  provider: 'anthropic' | 'openrouter',
): boolean {
  if (provider === 'openrouter') {
    // Codex round 6 [medium]: require vendor/model shape. The
    // OpenRouter API rejects bare model IDs with HTTP 400, so a
    // founder picking `claude-sonnet-4-6` while LLM_PROVIDER=openrouter
    // would brick every runtime LLM call until the value is rolled
    // back. Reject at validation instead.
    //
    // Vendor: lowercase alphanumerics + hyphens (matches existing
    // OpenRouter vendor IDs: anthropic, openai, x-ai, deepseek,
    // mistralai, google, meta-llama, ...).
    // Model: a-z0-9.-+ — accepts everything OpenRouter currently
    // emits (`claude-sonnet-4.6`, `gpt-5-turbo-preview`, `grok-4.1-fast`).
    return /^[a-z0-9-]+\/[a-z0-9.-]+$/.test(slug);
  }
  if (provider === 'anthropic') {
    // Codex round 5 [P2]: Anthropic native IDs MUST start with
    // `claude-` so we reject generic lowercase-hyphenated slugs like
    // `gpt-5` or `not-a-model` that would runtime-404 the moment the
    // founder applies them. AnthropicProvider passes the stored value
    // straight to messages.create({ model }), so persisting an
    // incompatible slug bricks every LLM call.
    //
    // The `[a-z0-9.-]+` tail is intentionally generous (hyphens AND
    // dots) — historical Anthropic IDs use either separator
    // (`claude-sonnet-4-6` vs `claude-3.5-sonnet-...`). Both forms are
    // accepted by the SDK.
    if (slug.includes('/')) return false;
    return /^claude-[a-z0-9.-]+$/.test(slug);
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
 * passes `isSlugCompatible`. On any ambiguity we drop the item
 * rather than guess.
 *
 * Codex round 5 [P2]: aligned the gate to `^claude-[a-z0-9.-]+$`. The
 * tail-after-prefix check below has to agree with that or the catalog
 * filter would hide entries that the gate would actually accept on
 * update.
 */
function normalizeAnthropicSlug(slug: string): string | null {
  if (!slug.startsWith('anthropic/')) return null;
  const tail = slug.slice('anthropic/'.length);
  // Map `.` → `-` (OpenRouter uses `claude-sonnet-4.6`; Anthropic SDK
  // historically uses `claude-sonnet-4-6`). The gate now accepts dots
  // too, but normalizing to hyphens preserves the safer canonical form
  // for SDK calls — Anthropic accepts both, the hyphen form is the
  // documented one.
  const candidate = tail.replace(/\./g, '-');
  // Final sanity: must still pass the same regex `isSlugCompatible`
  // uses in Anthropic mode. Drop the entry rather than guess.
  return /^claude-[a-z0-9.-]+$/.test(candidate) ? candidate : null;
}

// Codex round 6 on PR #188 [high]: expected_* now accepts THREE shapes:
//   - string slug: UI observed `source='global'` and sends the model
//     back as a string. Helper wraps it into `{ model: <slug> }` for
//     the repo subset-match.
//   - record (object): UI observed `source='global_mismatched'` (a
//     row exists but its provider doesn't match the active
//     LLM_PROVIDER) and is sending the FULL stored row back as the
//     expected token. The repo's subset-match compares the row to
//     itself and accepts the override, letting the update overwrite
//     the mismatched row atomically.
//   - null: UI observed `source='env'` or `'legacy'` (no global row
//     to race against). The repo's compare treats locked null +
//     expected null as a match.
const ExpectedTokenSchema = z.union([
  ModelSlugSchema,
  // Must be a non-array, non-null object. Permissive on field types
  // because the stored row's shape may grow (provider was added in
  // round 5; future fields may follow). The repo's subset-match does
  // the actual byte-for-byte comparison.
  z.record(z.string(), z.unknown()),
  z.null(),
]);

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
  //
  // Codex round 6 on PR #188 [high]: union with `record` to support
  // the `'global_mismatched'` source — UI sends the FULL stored row
  // back so the subset-match accepts the override.
  expected_main: ExpectedTokenSchema,
  expected_fast: ExpectedTokenSchema,
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
    // Codex round 6 [high]: when the source is `'global_mismatched'`,
    // surface the FULL stored row so the UI can send it as `expected_*`
    // and override the row atomically. For every other source the
    // `stored_*` field is null — the UI knows to send the string
    // value (or null) as appropriate.
    const storedMain =
      settings.main.source === 'global_mismatched' ? settings.main.stored : null;
    const storedFast =
      settings.fast.source === 'global_mismatched' ? settings.fast.stored : null;
    return {
      main: settings.main.value,
      fast: settings.fast.value,
      // Codex round 4 [high]: source flags consumed by the UI to
      // decide whether expected_* should be the observed value or
      // null. Tests assert the shape of this struct.
      // Codex round 6 [high]: source can now be 'global_mismatched'
      // (a global_settings row exists but its stored provider differs
      // from the active LLM_PROVIDER) — see `stored_main`/`stored_fast`.
      mainSource: settings.main.source,
      fastSource: settings.fast.source,
      stored_main: storedMain,
      stored_fast: storedFast,
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
   * first place.
   *
   * Codex round 6 on PR #188 [medium]: in OpenRouter mode, drop any
   * catalog item whose slug doesn't match the vendor/model shape the
   * gate now requires. The OpenRouter API itself returns vendor/model
   * for every item, so this is defensive — it makes the catalog and
   * the update-gate agree, so the operator can't pick a doomed slug
   * from the dropdown.
   */
  catalog: founderProcedure.query(async () => {
    const all = await getToolCallingModels();
    const env = envDefaults();
    const provider = env.provider as 'anthropic' | 'openrouter';
    if (provider === 'openrouter') {
      // Codex round 6 [medium]: filter the catalog through the same
      // gate the update mutation enforces. The OpenRouter API
      // normally returns only vendor/model items, but this defends
      // against a future catalog mutation (curated fallback, cache
      // poisoning) that might surface a bare slug.
      const items = all.filter((m) => isSlugCompatible(m.id, 'openrouter'));
      return { items, provider };
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
                ? // Codex round 5 [P2]: Anthropic mode requires a
                  // `claude-` prefixed SDK-native ID (e.g.
                  // `claude-sonnet-4-6`). Generic lowercase-hyphenated
                  // slugs like `gpt-5` or `not-a-model` are rejected
                  // because the runtime passes the value straight to
                  // messages.create() and the SDK 404s on every
                  // non-Anthropic slug.
                  'Anthropic provider requires a claude-* native short ID (e.g. claude-sonnet-4-6 — no slash, no vendor prefix). OpenRouter-style slugs like anthropic/claude-sonnet-4.6 and non-Anthropic IDs like gpt-5 are not accepted.'
                : // Codex round 6 [medium]: OpenRouter requires the
                  // vendor/model shape; bare model IDs like
                  // `claude-sonnet-4-6` 400 against the Chat
                  // Completions endpoint at runtime, so we reject at
                  // validation. Surface the expected shape so the
                  // operator can fix the slug in place.
                  "OpenRouter requires vendor/model format (e.g. 'anthropic/claude-sonnet-4.6', 'openai/gpt-5', 'x-ai/grok-4.1-fast'). " +
                  `Got: '${slug}'.`),
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
