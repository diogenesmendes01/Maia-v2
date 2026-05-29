-- Reverse of 062_global_settings.sql.
--
-- Codex round 5 on PR #188 [medium]:
--   The previous version of this file just `DROP TABLE IF EXISTS
--   global_settings`, on the theory that the `agent_facts` legacy
--   rows still exist (the up migration never deletes them) and
--   replaying 062 up would re-backfill them. That was wrong as soon
--   as ANY founder used the new admin-ui `/setup/llm-settings` page:
--   those writes land EXCLUSIVELY in `global_settings`, never in
--   `agent_facts`. Rolling back after a real incident-time switch
--   would silently drop the founder's choice and revert the runtime
--   to whichever stale value still lives in `agent_facts` (or the
--   env default if none).
--
-- Round 5 fix: BEFORE dropping the table, copy current `llm.model.main`
-- and `llm.model.fast` rows back into `agent_facts` under the legacy
-- storage shape the pre-062 code reads. The pre-062 setters wrote
-- under `(tenant_id='default', agent_id='default', escopo='global',
-- chave='llm.model.*')` — see git history for src/lib/llm-settings.ts
-- at commit 79645f69 — so we INSERT into that same row. `ON CONFLICT`
-- updates the row when it already exists so the migration is
-- idempotent against repeated up/down toggles.
--
-- The valor only carries `{model: "<slug>"}`. The round-5 shape stamps
-- `provider` too; we strip it here because the pre-062 reader only
-- looks at `.model`. Operators who care about preserving the provider
-- marker should re-save through the admin UI after a re-up.
--
-- Note on tenant scope: `global_settings` is process-wide (no tenant
-- discriminator). We materialize the backup under `'default'` /
-- `'default'` because that's the row the pre-062 code's
-- `factsRepo.getByKey` reads when `getCurrentTenant()`/
-- `getCurrentAgent()` are unset (Fastify dashboard handler context).
-- This is best-effort: if a deployment ran with a non-default
-- tenant/agent context for the legacy dashboard handler, the operator
-- needs to manually re-INSERT after rollback. The COMMENT below
-- documents this.

INSERT INTO agent_facts (
  tenant_id,
  agent_id,
  escopo,
  chave,
  valor,
  confianca,
  fonte,
  updated_at
)
SELECT
  'default' AS tenant_id,
  'default' AS agent_id,
  'global'  AS escopo,
  'llm.model.main' AS chave,
  jsonb_build_object('model', value->>'model') AS valor,
  1.00 AS confianca,
  'configurado' AS fonte,
  updated_at
FROM global_settings
WHERE key = 'llm.model.main'
  AND value ? 'model'
ON CONFLICT (tenant_id, agent_id, escopo, chave) DO UPDATE
  SET valor = EXCLUDED.valor,
      updated_at = EXCLUDED.updated_at,
      fonte = EXCLUDED.fonte;

INSERT INTO agent_facts (
  tenant_id,
  agent_id,
  escopo,
  chave,
  valor,
  confianca,
  fonte,
  updated_at
)
SELECT
  'default' AS tenant_id,
  'default' AS agent_id,
  'global'  AS escopo,
  'llm.model.fast' AS chave,
  jsonb_build_object('model', value->>'model') AS valor,
  1.00 AS confianca,
  'configurado' AS fonte,
  updated_at
FROM global_settings
WHERE key = 'llm.model.fast'
  AND value ? 'model'
ON CONFLICT (tenant_id, agent_id, escopo, chave) DO UPDATE
  SET valor = EXCLUDED.valor,
      updated_at = EXCLUDED.updated_at,
      fonte = EXCLUDED.fonte;

-- Now safe to drop: any operator choices made through the round-1
-- admin-ui were just mirrored back into agent_facts under the
-- legacy storage shape. Replaying 062 up will re-promote them; the
-- agent_facts rows survive the up migration unchanged.
DROP TABLE IF EXISTS global_settings;
