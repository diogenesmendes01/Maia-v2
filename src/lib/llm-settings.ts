import { sql } from 'drizzle-orm';
import { globalSettingsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

/**
 * Runtime LLM model selection.
 *
 * Storage: PR #188 / issue #183 — moved from `agent_facts` (per-tenant /
 * per-agent) to `global_settings` (process-wide). Codex round 1 [high]
 * showed the previous storage silently scoped the founder's "global" pick
 * to the founder's own `default` agent, so non-default agents and other
 * tenants kept using the env model. Now `getCurrent*Model` reads from
 * `global_settings.value.model`; if the key is unset (fresh DB) or the
 * DB query fails (hiccup), we fall back to the env defaults so the LLM
 * call never blocks on this lookup.
 *
 * Writes go through `setGlobalLLMSettingsAtomic` (or, internally, through
 * `globalSettingsRepo.updateAtomic` from `llmSettingsRouter`) — both audit
 * the change under a single tx with `SELECT ... FOR UPDATE` so concurrent
 * founder updates can't corrupt the audit trail (round 1 [medium]).
 *
 * Codex round 5 on PR #188 [high]: writes now persist `{ model, provider }`
 * instead of just `{ model }`. The provider field is the snapshot of
 * `config.LLM_PROVIDER` at write time. On read we compare the stored
 * provider against the CURRENT `config.LLM_PROVIDER`; on mismatch we
 * fall back to the env default (with a `llm_settings.provider_mismatch`
 * warn) so a provider env flip can't feed an Anthropic-native slug to
 * the OpenRouter HTTP client (or vice versa). Pre-round-5 rows that
 * carry only `{ model }` are trusted unchanged — migration 062 backfills
 * the provider marker via slug-shape inference, so the unmarked case
 * shrinks to deployments mid-rollout.
 *
 * The legacy `setCurrentMainModel` / `setCurrentFastModel` helpers below
 * are DEPRECATED SHIMS that exist only because `src/dashboard/index.ts`
 * (legacy Fastify dashboard, removed by PR #176) still imports them.
 *
 * Codex round 5 on PR #188 [high]: round 2 turned those shims into
 * unconditional throws to lock down the legacy owner-tier bypass. That
 * was too strict — the legacy POST handler is still mounted until
 * #176 lands, so every owner hitting the legacy form gets a 500 during
 * the very incident-response window the feature exists to support.
 * Round 5 reverts the shims to legacy storage (`agent_facts`) with a
 * `llm_settings.legacy_write_used` warn log; the dual-read fallback
 * still picks the value up at runtime. The founder gate on the new
 * `/setup/llm-settings` is unaffected. Both shims and the legacy
 * dashboard go away together when #176 merges.
 */
const KEY_MAIN = 'llm.model.main';
const KEY_FAST = 'llm.model.fast';

function envDefaultMain(): string {
  return config.LLM_PROVIDER === 'openrouter'
    ? config.OPENROUTER_MODEL_MAIN
    : config.CLAUDE_MODEL_MAIN;
}

function envDefaultFast(): string {
  return config.LLM_PROVIDER === 'openrouter'
    ? config.OPENROUTER_MODEL_FAST
    : config.CLAUDE_MODEL_FAST;
}

/**
 * Extract a non-empty string `.model` from an unknown jsonb value, or
 * return null. Shared between the global_settings read and the legacy
 * agent_facts fallback so both honor the same `{ "model": "<slug>" }`
 * payload shape.
 */
function extractModel(value: unknown): string | null {
  if (value && typeof value === 'object' && 'model' in value) {
    const m = (value as { model?: unknown }).model;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return null;
}

/**
 * Codex round 5 on PR #188 [high]: extract the optional `.provider`
 * marker persisted alongside `.model`. Returns null when missing
 * (legacy pre-round-5 rows that only stored `{ model: ... }`) or when
 * present but malformed. Callers treat null as "trust the stored
 * value" so existing pre-round-5 rows keep working — only rows
 * actively written under the new shape get the strict cross-check.
 */
function extractProvider(value: unknown): string | null {
  if (value && typeof value === 'object' && 'provider' in value) {
    const p = (value as { provider?: unknown }).provider;
    if (typeof p === 'string' && p.length > 0) return p;
  }
  return null;
}

/**
 * Codex round 3 on PR #188 [high]: dual-read fallback for runtime LLM
 * model lookup.
 *
 * Why: getCurrent*Model used to read ONLY `global_settings`. But the
 * legacy storage in `agent_facts (tenant_id=<founder>, agent_id=<founder>,
 * escopo='global', chave='llm.model.*')` still holds operator-selected
 * values until migration 062 runs. In a rolling deploy where new code
 * ships before the migration completes, or where the migration fails
 * mid-rollout, every runtime LLM call would silently ignore the
 * previously configured model and revert to the env default — exactly
 * the dangerous path during a provider outage or model deprecation
 * (the very scenarios the founder switched models for in the first
 * place).
 *
 * The fallback queries `agent_facts` directly via raw SQL — NOT through
 * `factsRepo`, because that reads under the current tenant_id/agent_id
 * context (and the runtime LLM call may not have any context set, or
 * may be set to a tenant other than the one that wrote the legacy row).
 *
 * Codex round 4 on PR #188 [high]: legacy_fallback_conflict guard.
 * Previously the fallback ordered by `updated_at DESC LIMIT 1` —
 * "freshest wins". This contradicts migration 062 which DETECTS distinct
 * legacy values across tenants and ABORTS rather than globalize them,
 * to avoid promoting one tenant's choice to every tenant at runtime.
 * The runtime fallback now mirrors that guard: if multiple distinct
 * model values exist across legacy rows, fail closed to env default
 * with a loud log. Single distinct value → promote it (safe; that's
 * the only legacy choice present). Zero rows → null (env handled by
 * caller).
 *
 * Logging:
 *   - `llm_settings.legacy_fallback_used` (warn) when we used the
 *     legacy row.
 *   - `llm_settings.legacy_fallback_conflict` (error) when multiple
 *     distinct legacy values exist — fail-closed to env.
 *   - `llm_settings.env_fallback_used` (warn) when we landed on the
 *     env default despite global_settings being expected to have a row.
 *
 * After the next major release (when no production deployment can be
 * pre-062), the legacy branch can be deleted along with the rest of
 * `agent_facts.escopo='global' AND chave LIKE 'llm.model.%'` cleanup.
 */
async function readLegacyAgentFactModel(key: string): Promise<string | null> {
  try {
    // Codex round 4 [high]: count distinct model values across all
    // legacy rows for this key. If more than one, the fallback would
    // promote one tenant's choice over another — exactly the unsafe
    // promotion migration 062 refuses. Fail-closed instead.
    const distinctResult = await db.execute<{ distinct_count: string }>(sql`
      SELECT COUNT(DISTINCT valor->>'model')::text AS distinct_count
      FROM agent_facts
      WHERE escopo = 'global'
        AND chave = ${key}
        AND valor ? 'model'
    `);
    const distinctRows = distinctResult.rows as Array<{ distinct_count: string }>;
    const distinctCount = Number(distinctRows[0]?.distinct_count ?? '0');

    if (distinctCount > 1) {
      logger.error(
        { distinct_count: distinctCount, key },
        'llm_settings.legacy_fallback_conflict',
      );
      // Fail-closed: refuse to promote any single tenant's choice
      // process-wide. Caller falls back to env default.
      return null;
    }

    if (distinctCount === 0) {
      return null;
    }

    // Exactly one distinct value — safe to promote it. Still pick the
    // freshest row in case multiple tenants wrote the SAME value (so the
    // returned row's updated_by/updated_at is the most recent observer).
    const result = await db.execute<{ valor: unknown }>(sql`
      SELECT valor
      FROM agent_facts
      WHERE escopo = 'global'
        AND chave = ${key}
        AND valor ? 'model'
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const rows = result.rows as Array<{ valor: unknown }>;
    if (rows.length === 0) return null;
    const model = extractModel(rows[0]!.valor);
    if (model) {
      logger.warn(
        { source: 'agent_facts', key },
        'llm_settings.legacy_fallback_used',
      );
      return model;
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, key },
      'llm_settings.legacy_read_failed',
    );
    return null;
  }
}

/**
 * Codex round 4 on PR #188 [high]: source-aware read for the admin UI.
 *
 * Why: the UI uses `expected_*` as an optimistic concurrency token. When
 * `global_settings` has zero rows (fresh install), `getCurrent*Model`
 * happily returns the env default, the UI submits THAT as expected, and
 * the helper builds `expected: { model: <env-default> }`. Inside the tx
 * the locked value is `null` (placeholder INSERT just landed), the
 * compare is `null !== { model: <env-default> }` → CONFLICT — every
 * first-ever update is rejected. Fresh deploys cannot use the page.
 *
 * Fix: return both the value AND its source. The admin UI now passes
 * `expected_main: null` when source is 'env' or 'legacy' (no
 * `global_settings` row to race against), and the repo's compare path
 * accepts `expected: null` as "no row expected" (already supported by
 * the `JSON.stringify` deep-equal — `null === null`).
 *
 * The legacy `getCurrentMainModel` / `getCurrentFastModel` helpers below
 * keep the string-only signature for runtime LLM callers that don't
 * need source info; they just delegate here and unwrap `.value`.
 */
export type LLMModelSource = 'global' | 'legacy' | 'env';
export type LLMModelRead = { value: string; source: LLMModelSource };

/**
 * Codex round 5 on PR #188 [high]: provider-compat check on read.
 *
 * Why: round 1 moved storage to global_settings but persisted only
 * `{ model }`. If the founder picked `claude-sonnet-4-6` while
 * `LLM_PROVIDER=anthropic`, then a deploy flipped `LLM_PROVIDER` to
 * `openrouter`, the runtime would happily feed the Anthropic-native
 * slug to the OpenRouter HTTP client — which would 400 on every call
 * because OpenRouter requires the `anthropic/claude-...` prefixed form.
 * Symmetric failure mode for the opposite flip.
 *
 * Fix: writes now persist `{ model, provider }` so each row carries
 * the provider context in which the value is valid. On read we compare
 * the stored `provider` against the current `config.LLM_PROVIDER`; if
 * they don't match we fall back to the env default (via the caller —
 * we return `null` here) and emit `llm_settings.provider_mismatch`.
 *
 * Pre-round-5 rows have no `.provider` field. We treat those as
 * "trust the stored slug" — backwards-compat with deployments that
 * already wrote `{ model }` before this round. The migration 062
 * backfill stamps a provider on existing rows so the gap is bounded.
 */
function isModelCompatibleWithCurrentProvider(value: unknown): {
  ok: boolean;
  storedProvider: string | null;
} {
  const storedProvider = extractProvider(value);
  if (storedProvider === null) {
    // Legacy shape (no provider marker) — trust it. Round 5 mostly
    // back-stops this with the migration 062 backfill that stamps a
    // provider, so this branch becomes increasingly rare in prod.
    return { ok: true, storedProvider: null };
  }
  return {
    ok: storedProvider === config.LLM_PROVIDER,
    storedProvider,
  };
}

async function readMainModelWithSource(): Promise<LLMModelRead> {
  // (1) Canonical source: global_settings.
  try {
    const f = await globalSettingsRepo.getByKey(KEY_MAIN);
    const model = extractModel(f?.value);
    if (model) {
      const compat = isModelCompatibleWithCurrentProvider(f?.value);
      if (!compat.ok) {
        logger.warn(
          {
            key: KEY_MAIN,
            stored_provider: compat.storedProvider,
            current_provider: config.LLM_PROVIDER,
            stored_model: model,
          },
          'llm_settings.provider_mismatch',
        );
        // Fall through to legacy → env default. Persisted value is
        // unsafe to feed the runtime under the current provider.
      } else {
        return { value: model, source: 'global' };
      }
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, key: KEY_MAIN },
      'llm_settings.global_read_failed',
    );
  }

  // (2) Rolling-deploy / pre-062 fallback: legacy agent_facts. Source
  // is 'legacy' so the UI can mark the expected token as null (the
  // global_settings row doesn't exist yet).
  const legacy = await readLegacyAgentFactModel(KEY_MAIN);
  if (legacy) return { value: legacy, source: 'legacy' };

  // (3) Final fallback: env default.
  logger.warn({ key: KEY_MAIN }, 'llm_settings.env_fallback_used');
  return { value: envDefaultMain(), source: 'env' };
}

async function readFastModelWithSource(): Promise<LLMModelRead> {
  try {
    const f = await globalSettingsRepo.getByKey(KEY_FAST);
    const model = extractModel(f?.value);
    if (model) {
      const compat = isModelCompatibleWithCurrentProvider(f?.value);
      if (!compat.ok) {
        logger.warn(
          {
            key: KEY_FAST,
            stored_provider: compat.storedProvider,
            current_provider: config.LLM_PROVIDER,
            stored_model: model,
          },
          'llm_settings.provider_mismatch',
        );
      } else {
        return { value: model, source: 'global' };
      }
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, key: KEY_FAST },
      'llm_settings.global_read_failed',
    );
  }

  const legacy = await readLegacyAgentFactModel(KEY_FAST);
  if (legacy) return { value: legacy, source: 'legacy' };

  logger.warn({ key: KEY_FAST }, 'llm_settings.env_fallback_used');
  return { value: envDefaultFast(), source: 'env' };
}

/**
 * Source-aware read used by the admin UI to know whether `expected_*`
 * tokens should be the observed value (source='global') or null (no
 * global_settings row exists — env/legacy source). See the comment on
 * LLMModelRead for the rationale.
 */
export async function getCurrentLLMSettings(): Promise<{
  main: LLMModelRead;
  fast: LLMModelRead;
}> {
  const [main, fast] = await Promise.all([
    readMainModelWithSource(),
    readFastModelWithSource(),
  ]);
  return { main, fast };
}

export async function getCurrentMainModel(): Promise<string> {
  const { value } = await readMainModelWithSource();
  return value;
}

export async function getCurrentFastModel(): Promise<string> {
  const { value } = await readFastModelWithSource();
  return value;
}

/**
 * Codex round 5 on PR #188 [high]: legacy shim soft-deprecation.
 *
 * Why the previous fail-loud was wrong:
 *   Round 2 turned these shims into unconditional throws on the theory
 *   that PR #176 was about to remove the only caller (legacy
 *   `/dashboard/llm-settings` POST). Until #176 lands, the legacy
 *   route stays wired up — so every owner who hits the legacy form
 *   gets a 500 during the very incident-response window the feature
 *   exists to support. That's worse than the original bypass risk
 *   (the founder gate has been live since round 1; legacy callers
 *   can't reach `global_settings` regardless).
 *
 * Round 5 fix (Option A):
 *   The shim now writes back to `agent_facts` (the legacy storage)
 *   under the caller's `tenant_id`/`agent_id` context, exactly as
 *   pre-round-1 code did. This keeps the legacy form functional —
 *   the founder/owner can still flip the model from the legacy UI —
 *   while the runtime read path (`getCurrent*Model`) primarily
 *   consults `global_settings` and falls back to `agent_facts` only
 *   when the canonical row is absent (the round 3 dual-read).
 *
 * Trade-off, fully spelled out so the next reader doesn't have to
 * reconstruct it:
 *   - In production with a single founder who uses ONLY the legacy
 *     form, `global_settings` stays empty and the runtime continues
 *     to serve from `agent_facts` (per the dual-read fallback). The
 *     dual-read fallback (round 4) refuses to promote when multiple
 *     distinct legacy values exist, so single-tenant operators are
 *     unaffected by that guard.
 *   - The legacy form's gate (`isOwnerType`) is weaker than the new
 *     `/setup/llm-settings` (founder-only + audited comment). Round
 *     2's lockdown reasoning still applies: ANY owner from the
 *     legacy form can change a runtime model with no audit comment.
 *     Round 5 accepts that risk for the bounded overlap window — PR
 *     #176 retires the legacy route entirely, at which point this
 *     shim becomes dead code and can be deleted along with these
 *     comments.
 *   - Each shim invocation emits `llm_settings.legacy_write_used` so
 *     operators can monitor how often the legacy form is still in
 *     play (chart it; when it goes to 0 in prod, #176 is safe to
 *     ship and this code is safe to delete).
 *
 * Restriction: we MUST NOT touch `src/dashboard/index.ts` from this
 * PR (it belongs to #176). That's why the soft-deprecation lives in
 * the shim and not at the route handler.
 *
 * @deprecated The supported write path is admin-ui
 * `/setup/llm-settings` (founder-only, audited via
 * `llmSettingsRouter.update` → `setGlobalLLMSettingsAtomic`). The
 * legacy shims remain only for the brief overlap window between this
 * PR and #176.
 */
export async function setCurrentMainModel(model: string): Promise<void> {
  await writeLegacyAgentFactModel(KEY_MAIN, model);
}

/**
 * @deprecated See `setCurrentMainModel` — same legacy-storage fallback,
 * same overlap-window rationale.
 */
export async function setCurrentFastModel(model: string): Promise<void> {
  await writeLegacyAgentFactModel(KEY_FAST, model);
}

/**
 * Internal helper for the round-5 legacy shims. Writes the
 * `{ "model": <slug> }` payload into `agent_facts` under a
 * synthetic tenant/agent context (matching the pre-round-1
 * single-tenant behavior of these setters). NOT used by the new
 * admin-ui flow — that path goes through `setGlobalLLMSettingsAtomic`
 * directly.
 *
 * Why the synthetic context: the legacy POST `/dashboard/llm-settings`
 * Fastify handler does NOT wrap the request in `runWithTenantContext`
 * (there's no global tenant middleware in `src/dashboard/index.ts`).
 * Pre-round-1 callers therefore relied on `agent_facts.tenant_id`'s
 * default value (`'default'`) — but `factsRepo.upsert` runs through
 * `applyTenantGuard`, which raises `MissingTenantContextError` when no
 * context is active. To preserve the legacy single-tenant behavior
 * we wrap the upsert in `runWithTenantContext({tenant_id:'default',
 * agent_id:'default'}, ...)`. That mirrors the original storage row
 * (`agent_facts (tenant_id='default', agent_id='default', escopo=
 * 'global', chave='llm.model.*')`), which the dual-read fallback in
 * `readLegacyAgentFactModel` knows how to find.
 *
 * The deprecation log is emitted at WARN so operators can chart the
 * legacy-form usage and confirm zero hits before PR #176 retires the
 * legacy route — at which point this entire helper and both shims
 * become dead code.
 */
async function writeLegacyAgentFactModel(
  key: string,
  model: string,
): Promise<void> {
  logger.warn(
    { key, caller_route: 'legacy /dashboard/llm-settings (presumed)', model },
    'llm_settings.legacy_write_used',
  );
  // Imported here (not at module top) so the unit test mock for
  // `repositories.js` and `tenant-context.js` can swap the real
  // implementations before this code runs — module-level imports
  // would resolve before the vi.mock hooks fire on first import of
  // llm-settings.ts.
  const { factsRepo } = await import('@/db/repositories.js');
  const { runWithTenantContext } = await import('@/db/tenant-context.js');
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    async () => {
      await factsRepo.upsert({
        escopo: 'global',
        chave: key,
        valor: { model },
        fonte: 'configurado',
      });
    },
  );
}

/**
 * Atomic founder-driven LLM model switch. Writes BOTH keys + audit inside
 * one tx, with `SELECT ... FOR UPDATE` on each row so concurrent updates
 * serialize and the audit row sees the real locked before/after. Used by
 * `llmSettingsRouter.update`.
 *
 * Returns the discriminated `globalSettingsRepo.updateAtomic` union so the
 * router can map `no_changes` → BAD_REQUEST without sniffing exception
 * shapes.
 */
export async function setGlobalLLMSettingsAtomic(input: {
  main: string;
  fast: string;
  // Codex round 3 on PR #188 [P2]: optimistic concurrency. The founder
  // passes the values they OBSERVED on page load. Inside the tx (under
  // FOR UPDATE), the repo verifies the locked value matches each
  // expected_*; if anything moved underneath, the helper returns
  // `optimistic_conflict` and the router maps it to 409 CONFLICT. The
  // UI then prompts "Settings changed concurrently — refresh and try
  // again." Both required so the founder can't accidentally skip the
  // check.
  //
  // Codex round 4 on PR #188 [high]: null means "I expect no row in
  // global_settings" (source='env' or 'legacy' — the UI didn't observe
  // any persisted row, just a fallback value). The repo compares the
  // locked value against `null` and proceeds when the row genuinely
  // has no payload (placeholder JSON null, never-set, etc.). String
  // means "I observed exactly this stored value." Either is valid;
  // the router schema accepts both (z.string().nullable()).
  expected_main: string | null;
  expected_fast: string | null;
  updated_by: string;
  actor_role: string;
  tenant_id: string;
  comment: string;
}): Promise<
  | {
      ok: true;
      applied_at: Date;
      before: { main: string | null; fast: string | null };
      after: { main: string; fast: string };
    }
  | {
      ok: false;
      reason: 'no_changes';
      before: { main: string | null; fast: string | null };
    }
  | {
      ok: false;
      reason: 'optimistic_conflict';
      // Which side conflicted ('main' | 'fast' for LLM use; pass-through
      // of the repo's `key` minus the 'llm.model.' prefix).
      field: 'main' | 'fast';
      // Both are slug strings (or null for "expected unset" / "currently
      // unset") — the helper normalizes the repo's jsonb shape into the
      // string form the UI expects.
      expected: string | null;
      current: string | null;
    }
> {
  // Codex round 4 [high]: when expected_* is null the UI is telling
  // us "no row should exist" (source was env or legacy). The repo
  // compares `lockedValue === null` (placeholder JSON null) against
  // `null` and proceeds. When expected_* is a string we wrap it in
  // the same `{ model: <slug> }` shape persisted writes use.
  //
  // Codex round 5 [high]: writes now ALSO persist `provider` so the
  // read path can detect provider env flips and refuse to feed an
  // incompatible slug to the runtime. The `expected` comparison still
  // wraps only `{ model }` because pre-round-5 rows have no provider
  // marker — comparing against the stored shape (which includes
  // provider on round-5+ writes) would falsely conflict on any row
  // observed before the first round-5 write. The expected check is
  // a model-identity guard, not a provider-marker guard.
  const wrapExpected = (v: string | null): Record<string, unknown> | null =>
    v === null ? null : { model: v };

  // Codex round 5 [high]: stamp the CURRENT provider on each write
  // so the read path can validate that the slug was authored under
  // the same provider context now in effect.
  const currentProvider = config.LLM_PROVIDER;

  const res = await globalSettingsRepo.updateAtomic({
    keys: [
      {
        key: KEY_MAIN,
        value: { model: input.main, provider: currentProvider },
        expected: wrapExpected(input.expected_main),
      },
      {
        key: KEY_FAST,
        value: { model: input.fast, provider: currentProvider },
        expected: wrapExpected(input.expected_fast),
      },
    ],
    audit: {
      tenant_id: input.tenant_id,
      actor_id: input.updated_by,
      actor_role: input.actor_role,
      action: 'llm_model_changed',
      resource_type: 'llm_settings',
      meta: { comment: input.comment },
    },
  });

  // Unwrap the raw json values into the typed before/after shape the
  // router (and tests) expect. `before[KEY_MAIN]` is null when the key
  // was never set, or { model: '<slug>' } otherwise — normalize to the
  // slug string (or null).
  function normalize(raw: unknown): string | null {
    if (raw && typeof raw === 'object' && raw !== null && 'model' in raw) {
      const m = (raw as { model?: unknown }).model;
      if (typeof m === 'string' && m.length > 0) return m;
    }
    return null;
  }

  if (!res.ok) {
    if (res.reason === 'optimistic_conflict') {
      // Translate the repo's key namespace back to the LLM-domain
      // `main`/`fast` discriminator the router exposes to the UI.
      const field: 'main' | 'fast' = res.key === KEY_MAIN ? 'main' : 'fast';
      return {
        ok: false as const,
        reason: 'optimistic_conflict' as const,
        field,
        expected: normalize(res.expected),
        current: normalize(res.current),
      };
    }
    return {
      ok: false as const,
      reason: res.reason,
      before: {
        main: normalize(res.before[KEY_MAIN]),
        fast: normalize(res.before[KEY_FAST]),
      },
    };
  }
  return {
    ok: true as const,
    applied_at: res.applied_at,
    before: {
      main: normalize(res.before[KEY_MAIN]),
      fast: normalize(res.before[KEY_FAST]),
    },
    after: {
      main: input.main,
      fast: input.fast,
    },
  };
}

export function envDefaults(): { main: string; fast: string; provider: string } {
  return {
    main: envDefaultMain(),
    fast: envDefaultFast(),
    provider: config.LLM_PROVIDER,
  };
}

// Test seam: exported so the integration test in
// tests/integration/global-settings-repo.spec.ts can reach the canonical
// keys without re-typing them.
export const _internal = {
  KEY_MAIN,
  KEY_FAST,
};
