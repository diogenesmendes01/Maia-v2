-- Down migration for 074_agent_audience_profiles.sql
-- WARNING: destructive — drops `agent_audience_profiles` (and every
-- backfilled / operator-edited audience profile) and restores the GLOBAL
-- unique on `pessoas.telefone_whatsapp`.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain
-- only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md.
--
-- CAVEAT: restoring the global unique only succeeds if no two rows share a
-- telefone_whatsapp across (tenant, agent) — i.e. the per-agent feature this
-- migration enabled has not actually been used to create a duplicate phone.
-- If it has, the ADD CONSTRAINT below will fail and the duplicates must be
-- reconciled first (this is expected: the down is a true inverse only while
-- the new capability is unused).

-- Drop the per-agent relation (its trigger + indexes drop with the table).
DROP TABLE IF EXISTS agent_audience_profiles;

-- Reverse the unique relaxation: composite → global.
ALTER TABLE pessoas DROP CONSTRAINT IF EXISTS pessoas_tenant_agent_telefone_key;

ALTER TABLE pessoas
  ADD CONSTRAINT pessoas_telefone_whatsapp_key UNIQUE (telefone_whatsapp);
