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
