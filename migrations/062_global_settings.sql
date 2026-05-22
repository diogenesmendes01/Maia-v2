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
-- Backfill is deterministic: pick the agent_facts row with the most
-- recent `updated_at` for each chave. If two founders/agents both
-- touched the legacy UI, we honor the freshest one — same heuristic an
-- operator would apply mentally when reading the legacy dashboard.
-- `agent_facts.valor` is already jsonb in the same `{"model": "..."}`
-- shape `getCurrent*Model` expects (see src/lib/llm-settings.ts), so we
-- copy it verbatim. `ON CONFLICT (key) DO NOTHING` makes the backfill
-- idempotent against the placeholder rows the race-safe `updateAtomic`
-- path now inserts (see `globalSettingsRepo.updateAtomic`).
--
-- `updated_by = 'system:migration_062_backfill'` is the forensic marker;
-- the source `agent_facts.updated_at` is preserved so operators can see
-- when the value was originally set in the legacy table.
INSERT INTO global_settings (key, value, updated_at, updated_by)
SELECT
  'llm.model.main' AS key,
  valor AS value,
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
  valor AS value,
  updated_at,
  'system:migration_062_backfill' AS updated_by
FROM agent_facts
WHERE escopo = 'global'
  AND chave = 'llm.model.fast'
  AND valor ? 'model'
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (key) DO NOTHING;
