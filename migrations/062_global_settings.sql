-- Issue #183 (Codex round 1 on PR #188, [high]):
--   The /setup/llm-settings page wrote the runtime model choice into
--   `agent_facts (tenant_id, agent_id='default', escopo='global', chave='llm.model.*')`.
--   Runtime callLLM reads the same key but under the CURRENT request's
--   (tenant_id, agent_id) AsyncLocalStorage context — which for any
--   non-default agent (or any other tenant) is a different row entirely.
--   Result: founder UI showed "Applied, audited", but those other agents
--   kept calling the old/env model — defeating the incident-response
--   purpose of the page.
--
-- Fix: store LLM model picks in a process-wide table, with NO tenant_id /
-- agent_id discriminator. `llm.model.main` and `llm.model.fast` are
-- truly global runtime settings (one process serves all tenants, all
-- tenants share the upstream LLM connection pool, the founder switching
-- mid-incident wants every next ReAct turn — for every tenant, every
-- agent — to pick up the new slug on the next read).
--
-- Schema is intentionally generic key→jsonb (matches agent_facts shape)
-- so future global settings (rate-limit overrides, feature flags scoped
-- to the entire deployment, etc.) can reuse the table without a new
-- migration. `updated_by` is a free-text email/user_id so we don't need
-- a FK to a users table that doesn't exist (admin_audit_log gets the
-- richer record; this column is for quick `last writer` triage).
CREATE TABLE IF NOT EXISTS global_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

COMMENT ON TABLE global_settings IS
  'Process-wide singleton settings (one row per logical setting key). NOT scoped to tenant/agent — by design. See migration 062 + admin-ui/trpc/routers/llmSettings.ts.';

COMMENT ON COLUMN global_settings.key IS
  'Setting name. Reserved keys today: llm.model.main, llm.model.fast.';

COMMENT ON COLUMN global_settings.value IS
  'JSON payload. For llm.model.* it is { "model": "<slug>" } to mirror the prior agent_facts shape so callers can keep the same valor-extraction logic.';

COMMENT ON COLUMN global_settings.updated_by IS
  'Last writer email / user_id. Forensic shortcut; the full audit trail lives in admin_audit_log (action=global_settings_update).';

-- Codex round 2 on PR #188 [P2]: deployments that already used the legacy
-- `/dashboard/llm-settings` UI have an `agent_facts (tenant_id=<founder>,
-- agent_id=<founder>, escopo='global', chave='llm.model.main'|'llm.model.fast')`
-- row holding `valor = {"model": "<slug>"}`. The runtime read path no
-- longer consults `agent_facts` (round 1 [high] fix — see migration
-- header), so without a backfill the runtime model silently drops back
-- to the env default for everyone on the first deploy after this
-- migration runs, until a founder re-saves via the new admin-ui page.
--
-- Codex round 3 on PR #188 [high]: the original backfill below picked
-- the `agent_facts` row with the most recent `updated_at` per chave and
-- promoted its `valor` to process-wide `global_settings`. But the legacy
-- table was keyed by `(tenant_id, agent_id, escopo, chave)`, so multiple
-- tenants/agents may legitimately hold DIFFERENT `llm.model.*` rows —
-- e.g. tenant A picked `openai/gpt-5` mid-incident while tenant B kept
-- the env default and tenant C experimented with `x-ai/grok-4.1-fast`.
-- Picking "freshest" silently globalizes ONE tenant's stale or
-- experimental setting to EVERY tenant on upgrade, with no conflict
-- detection and no record of what was discarded. That's a worse
-- forensic gap than just leaving the key unset.
--
-- Fix: fail-closed. If multiple distinct `valor->>'model'` values exist
-- for either key, RAISE EXCEPTION and abort the migration. The operator
-- has to manually pick the canonical row (DELETE the others, or move
-- them to a tenant-scoped key first) before re-running 062 up. If
-- exactly one distinct value exists across all rows, the existing
-- `INSERT ... SELECT ... LIMIT 1 ON CONFLICT DO NOTHING` is correct
-- (any row → same value). If zero rows exist (fresh deploy / no legacy
-- use), the SELECT is empty and the INSERT is a no-op, so the key stays
-- unset and the env default takes over until a founder uses the new
-- admin-ui page. This is the most conservative path: forcing a manual
-- choice on upgrade beats silently promoting one tenant's value to all.
--
-- `agent_facts.valor` is already jsonb in the same `{"model": "..."}`
-- shape `getCurrent*Model` expects (see src/lib/llm-settings.ts), so we
-- copy it verbatim. `ON CONFLICT (key) DO NOTHING` makes the backfill
-- idempotent against the placeholder rows the race-safe `updateAtomic`
-- path now inserts (see `globalSettingsRepo.updateAtomic`).
--
-- `updated_by = 'system:migration_062_backfill'` is the forensic marker;
-- the source `agent_facts.updated_at` is preserved so operators can see
-- when the value was originally set in the legacy table.
DO $$
DECLARE
  distinct_main int;
  distinct_fast int;
BEGIN
  SELECT COUNT(DISTINCT valor->>'model') INTO distinct_main
  FROM agent_facts
  WHERE escopo = 'global'
    AND chave = 'llm.model.main'
    AND valor ? 'model';

  SELECT COUNT(DISTINCT valor->>'model') INTO distinct_fast
  FROM agent_facts
  WHERE escopo = 'global'
    AND chave = 'llm.model.fast'
    AND valor ? 'model';

  IF distinct_main > 1 THEN
    RAISE EXCEPTION 'Migration 062: % distinct llm.model.main values found in legacy agent_facts. Backfill aborted — promoting one tenant''s value to every tenant would silently override the others. Resolve manually before re-running: pick the canonical agent_facts row, DELETE the rest, then re-run migration 062 up.', distinct_main;
  END IF;

  IF distinct_fast > 1 THEN
    RAISE EXCEPTION 'Migration 062: % distinct llm.model.fast values found in legacy agent_facts. Same resolution as llm.model.main above.', distinct_fast;
  END IF;
END $$;

-- Codex round 5 on PR #188 [high]: writes through the new admin-ui
-- helper now persist `{ model, provider }` so the read path can
-- detect `LLM_PROVIDER` env flips that would brick the runtime
-- (Anthropic-native slug feeding the OpenRouter HTTP client and
-- vice versa). The backfill below stamps a `provider` on the
-- migrated value too, INFERRING it from the slug shape:
--
--   slug containing `/` → OpenRouter canonical form
--   (anthropic/claude-..., openai/gpt-5, x-ai/grok-..., ...). The
--   OpenRouter HTTP API is the only consumer of this form.
--
--   slug without `/` → Anthropic-native short ID (claude-sonnet-4-6,
--   claude-haiku-4-5-20251001, ...). AnthropicProvider passes the
--   slug straight to messages.create(), which only accepts this form.
--
-- This is a best-effort inference: if the operator stored an
-- ambiguous custom slug (e.g. a fine-tune ID with no `/`), the
-- backfill defaults to `anthropic` and the read-path provider gate
-- will surface a `llm_settings.provider_mismatch` warn on the next
-- call under `LLM_PROVIDER=openrouter`, prompting the operator to
-- re-save through the admin UI. The warn includes both the stored
-- slug and the stored vs current provider so the misclassification
-- is observable rather than silent.
INSERT INTO global_settings (key, value, updated_at, updated_by)
SELECT
  'llm.model.main' AS key,
  jsonb_build_object(
    'model', valor->>'model',
    'provider', CASE
      WHEN (valor->>'model') LIKE '%/%' THEN 'openrouter'
      ELSE 'anthropic'
    END
  ) AS value,
  updated_at,
  'system:migration_062_backfill' AS updated_by
FROM agent_facts
WHERE escopo = 'global'
  AND chave = 'llm.model.main'
  AND valor ? 'model'
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (key) DO NOTHING;

INSERT INTO global_settings (key, value, updated_at, updated_by)
SELECT
  'llm.model.fast' AS key,
  jsonb_build_object(
    'model', valor->>'model',
    'provider', CASE
      WHEN (valor->>'model') LIKE '%/%' THEN 'openrouter'
      ELSE 'anthropic'
    END
  ) AS value,
  updated_at,
  'system:migration_062_backfill' AS updated_by
FROM agent_facts
WHERE escopo = 'global'
  AND chave = 'llm.model.fast'
  AND valor ? 'model'
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (key) DO NOTHING;
