import { sql } from 'drizzle-orm';
import { globalSettingsRepo } from '@/db/repositories.js';
import { db } from '@/db/client.js';
// Módulo COMPARTILHADO por mais de um container (runtime e admin-ui): lê o
// contrato sob demanda em vez de arrastar o boot do subset `runtime` para
// dentro do console. Ver src/config/contract-env.ts (issue #596).
import { contractEnv as config } from '@/config/contract-env.js';
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
 * Codex round 6 on PR #188 [high]: provider-mismatch UI repair. The
 * round-5 read path fell back to `source='env'` on mismatch, and the
 * UI then submitted `expected_*: null`. But the mismatched row still
 * EXISTS in `global_settings` — `updateAtomic`'s pre-tx subset-match
 * compares `null` against the locked `{model, provider}` value and
 * raises `optimistic_conflict`. The UI was stuck: every save attempt
 * failed CONFLICT, the founder couldn't repair the row from the page.
 * Fix: a new `'global_mismatched'` source surfaces the FULL stored
 * value as `stored`, so the UI can submit it as the expected token.
 * The repo's subset-match accepts it and the update proceeds
 * atomically. The audit row records the real before (mismatched row)
 * and after (current-provider-compatible row).
 *
 * Legacy shims (`setCurrentMainModel` / `setCurrentFastModel`) were
 * REMOVED in round 6 after PR #176 retired the legacy Fastify dashboard
 * — they had no remaining callers.
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
 * Codex round 6 on PR #188 [high]: a fourth source, `'global_mismatched'`,
 * was added to repair the provider-mismatch CONFLICT loop. Before
 * round 6, mismatch fell through to legacy/env and the UI submitted
 * `expected_*: null` — but the row still existed in global_settings,
 * so the repo's locked value was `{model, provider}` (not null), and
 * the subset-match compared `null` against an object → CONFLICT. The
 * UI loop "save → CONFLICT → refresh → still env → save → CONFLICT"
 * never terminated. Now mismatch returns the full stored row in
 * `.stored`; the UI submits it as `expected_*` and the repo's
 * subset-match accepts it (the stored value matches itself), and the
 * update proceeds atomically with a real before/after in the audit.
 *
 * The legacy `getCurrentMainModel` / `getCurrentFastModel` helpers below
 * keep the string-only signature for runtime LLM callers that don't
 * need source info; they just delegate here and unwrap `.value`.
 */
export type LLMModelSource = 'global' | 'global_mismatched' | 'legacy' | 'env';

/**
 * `value`: the runtime-safe slug (env fallback when source is
 * 'global_mismatched', 'legacy', or 'env'; the persisted value when
 * source is 'global').
 *
 * `source`:
 *   - 'global' — value came from a global_settings row whose stored
 *     provider matches the current `config.LLM_PROVIDER`. UI sends
 *     the value back as `expected_*` for optimistic concurrency.
 *   - 'global_mismatched' — a global_settings row exists but its
 *     stored provider does NOT match the current config. The runtime
 *     served the env default (the stored slug is unsafe to call under
 *     the new provider). The UI sends the FULL `.stored` object as
 *     `expected_*` so the repo's subset-match accepts it and the
 *     update overwrites the row with a current-provider-compatible
 *     value. See round 6 [high] note above.
 *   - 'legacy' — value came from the agent_facts dual-read fallback.
 *     No global_settings row exists yet, so the UI sends `null`.
 *   - 'env' — no row in global_settings and no usable legacy row.
 *     UI sends `null`.
 *
 * `stored`: only populated when `source === 'global_mismatched'`. The
 * raw jsonb value of the conflicting row (whatever shape it carries,
 * typically `{model, provider}`). The UI passes it through unchanged
 * as `expected_*` so the repo's subset-match accepts the override.
 */
export type LLMModelRead =
  | { value: string; source: 'global' | 'legacy' | 'env' }
  | {
      value: string;
      source: 'global_mismatched';
      stored: Record<string, unknown>;
    };

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
        // Codex round 6 [high]: surface the FULL stored row as
        // `stored` so the admin UI can submit it as `expected_*`. The
        // returned `value` is the env default so runtime LLM callers
        // never feed the unsafe slug to the wrong provider's client.
        return {
          value: envDefaultMain(),
          source: 'global_mismatched',
          stored: f!.value as Record<string, unknown>,
        };
      }
      return { value: model, source: 'global' };
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
        return {
          value: envDefaultFast(),
          source: 'global_mismatched',
          stored: f!.value as Record<string, unknown>,
        };
      }
      return { value: model, source: 'global' };
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
 * Atomic founder-driven LLM model switch. Writes BOTH keys + audit inside
 * one tx, with `SELECT ... FOR UPDATE` on each row so concurrent updates
 * serialize and the audit row sees the real locked before/after. Used by
 * `llmSettingsRouter.update`.
 *
 * Returns the discriminated `globalSettingsRepo.updateAtomic` union so the
 * router can map `no_changes` → BAD_REQUEST without sniffing exception
 * shapes.
 *
 * Codex round 6 on PR #188 [high]: `expected_*` accepts either a slug
 * string (UI observed `source='global'` and sends the model back) or a
 * full `Record<string, unknown>` (UI observed `source='global_mismatched'`
 * and sends the stored row back) or `null` (UI observed env/legacy and
 * sends "no row expected"). The helper wraps strings into `{ model }`
 * for the repo's subset-match; objects pass through unchanged so the
 * compare matches the stored value byte-for-byte.
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
  //
  // Codex round 6 on PR #188 [high]: object means "I observed a row
  // whose stored provider does NOT match the current LLM_PROVIDER —
  // I'm sending it back verbatim so the subset-match accepts the
  // override." The router builds this from `getCurrentLLMSettings`'s
  // `stored` field when `source === 'global_mismatched'`.
  expected_main: string | Record<string, unknown> | null;
  expected_fast: string | Record<string, unknown> | null;
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
  //
  // Codex round 6 [high]: when the UI saw `source='global_mismatched'`
  // it passes the FULL stored row as an object. We pass it through
  // unchanged so the repo's subset-match compares the stored value to
  // itself (every field matches by definition). That's how the UI
  // overrides a row whose stored provider doesn't match the active
  // LLM_PROVIDER — strings would skip the provider field, but the
  // mismatched row has a provider that doesn't equal current; if we
  // wrapped to `{model}` and the stored row also had a `model` we'd
  // still match by subset, but using the FULL stored shape is more
  // explicit about intent and survives future schema growth.
  const wrapExpected = (
    v: string | Record<string, unknown> | null,
  ): Record<string, unknown> | null => {
    if (v === null) return null;
    if (typeof v === 'string') return { model: v };
    return v;
  };

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

  // Issue #508: a escrita é a única fonte de verdade que muda o modelo em
  // runtime, então é aqui que a invalidação distribuída nasce — não no router
  // do Admin. Import dinâmico para não criar ciclo
  // (cache-invalidation → model-resolver → llm-settings).
  //
  // Fire-and-forget de propósito: a escrita JÁ foi commitada no Postgres. Se o
  // save do Admin esperasse o Redis, uma indisponibilidade de cache viraria
  // latência (ou erro) numa operação que já teve sucesso. Sem a mensagem, cada
  // réplica ainda converge pelo TTL curto do cache de settings.
  if (res.ok) {
    void import('@/lib/llm/cache-invalidation.js')
      .then((m) => m.publishLLMSettingsInvalidation())
      .catch(() => undefined);
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
