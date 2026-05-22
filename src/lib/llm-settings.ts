import { globalSettingsRepo } from '@/db/repositories.js';
import { config } from '@/config/env.js';

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
 * The legacy `setCurrentMainModel` / `setCurrentFastModel` helpers below
 * are SHIMS — they exist only because `src/dashboard/index.ts` (legacy
 * Fastify dashboard, removed by PR #176) still imports them. Once #176
 * mergers, both shims and the dashboard go away together. The shims write
 * directly to `global_settings` (single-key, no audit row) so behavior
 * stays consistent if anyone manages to hit the legacy route mid-overlap;
 * they DO NOT use the atomic helper because the legacy dashboard wasn't
 * audited either, and a partial-write fallback there is fine.
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

export async function getCurrentMainModel(): Promise<string> {
  try {
    const f = await globalSettingsRepo.getByKey(KEY_MAIN);
    const valor = f?.value as { model?: unknown } | null | undefined;
    if (valor && typeof valor.model === 'string' && valor.model.length > 0) {
      return valor.model;
    }
  } catch {
    // DB hiccup: fall through to env default rather than block the LLM call.
  }
  return envDefaultMain();
}

export async function getCurrentFastModel(): Promise<string> {
  try {
    const f = await globalSettingsRepo.getByKey(KEY_FAST);
    const valor = f?.value as { model?: unknown } | null | undefined;
    if (valor && typeof valor.model === 'string' && valor.model.length > 0) {
      return valor.model;
    }
  } catch {
    // ditto
  }
  return envDefaultFast();
}

/**
 * @deprecated Use `setGlobalLLMSettingsAtomic` from llmSettingsRouter (or
 * `globalSettingsRepo.updateAtomic` directly) so the change is audited
 * atomically. Kept here only as a compat shim for `src/dashboard/index.ts`
 * (legacy Fastify dashboard removed by PR #176). When #176 lands, delete
 * this function and its caller in the legacy dashboard together.
 */
export async function setCurrentMainModel(model: string): Promise<void> {
  await globalSettingsRepo.updateAtomic({
    keys: [{ key: KEY_MAIN, value: { model } }],
    audit: {
      tenant_id: 'system',
      actor_id: 'legacy-dashboard',
      actor_role: 'system',
      action: 'llm_model_changed_legacy',
      resource_type: 'llm_settings',
      meta: { source: 'legacy_dashboard_shim' },
    },
  });
}

/**
 * @deprecated See `setCurrentMainModel` — same shim, same removal plan.
 */
export async function setCurrentFastModel(model: string): Promise<void> {
  await globalSettingsRepo.updateAtomic({
    keys: [{ key: KEY_FAST, value: { model } }],
    audit: {
      tenant_id: 'system',
      actor_id: 'legacy-dashboard',
      actor_role: 'system',
      action: 'llm_model_changed_legacy',
      resource_type: 'llm_settings',
      meta: { source: 'legacy_dashboard_shim' },
    },
  });
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
> {
  const res = await globalSettingsRepo.updateAtomic({
    keys: [
      { key: KEY_MAIN, value: { model: input.main } },
      { key: KEY_FAST, value: { model: input.fast } },
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
    if (raw && typeof raw === 'object' && 'model' in raw) {
      const m = (raw as { model?: unknown }).model;
      if (typeof m === 'string' && m.length > 0) return m;
    }
    return null;
  }

  if (!res.ok) {
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
