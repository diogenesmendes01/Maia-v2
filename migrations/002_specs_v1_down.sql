-- Down migration for 002_specs_v1.sql
-- WARNING: destructive — review before applying. Run in transaction.
-- =====================================================================
-- Reverts:
--   - drops dashboard_sessions, import_entries, import_runs,
--     dead_letter_jobs, system_health_events, idempotency_keys,
--     pending_questions, entity_states, contrapartes,
--     permission_profiles
--   - removes contraparte_id from transacoes
--   - removes profile_id, status from permissoes
--   - reverts pessoas.status CHECK to the 001 form (no 'quarentena')
--   - drops pg_trgm extension
-- =====================================================================

BEGIN;

-- ---------- dashboard_sessions ----------
DROP TABLE IF EXISTS dashboard_sessions CASCADE;

-- ---------- import_entries / import_runs ----------
DROP TABLE IF EXISTS import_entries CASCADE;
DROP TRIGGER IF EXISTS set_updated_at_import_runs ON import_runs;
DROP TABLE IF EXISTS import_runs CASCADE;

-- ---------- dead_letter_jobs ----------
DROP TABLE IF EXISTS dead_letter_jobs CASCADE;

-- ---------- system_health_events ----------
DROP TABLE IF EXISTS system_health_events CASCADE;

-- ---------- idempotency_keys ----------
DROP TABLE IF EXISTS idempotency_keys CASCADE;

-- ---------- pending_questions ----------
DROP TABLE IF EXISTS pending_questions CASCADE;

-- ---------- entity_states ----------
DROP TRIGGER IF EXISTS set_updated_at_entity_states ON entity_states;
DROP TABLE IF EXISTS entity_states CASCADE;

-- ---------- pessoas: revert 'quarentena' status ----------
-- Move any rows in 'quarentena' to 'inativa' so the old CHECK does not fail.
UPDATE pessoas SET status = 'inativa' WHERE status = 'quarentena';
ALTER TABLE pessoas DROP CONSTRAINT IF EXISTS pessoas_status_check;
ALTER TABLE pessoas ADD CONSTRAINT pessoas_status_check
  CHECK (status IN ('ativa','inativa','bloqueada'));

-- ---------- permissoes: drop columns added in 002 ----------
DROP INDEX IF EXISTS idx_permissoes_status;
ALTER TABLE permissoes DROP COLUMN IF EXISTS status;
ALTER TABLE permissoes DROP COLUMN IF EXISTS profile_id;

-- ---------- permission_profiles ----------
-- Must come after permissoes loses its FK to permission_profiles.
DROP TABLE IF EXISTS permission_profiles CASCADE;

-- ---------- transacoes.contraparte_id ----------
DROP INDEX IF EXISTS idx_transacoes_contraparte;
ALTER TABLE transacoes DROP COLUMN IF EXISTS contraparte_id;

-- ---------- contrapartes ----------
DROP TRIGGER IF EXISTS set_updated_at_contrapartes ON contrapartes;
DROP TABLE IF EXISTS contrapartes CASCADE;

-- ---------- pg_trgm extension ----------
-- NOTE: only drop if no other schema uses it.
DROP EXTENSION IF EXISTS pg_trgm;

COMMIT;
