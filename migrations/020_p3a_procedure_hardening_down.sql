-- Down migration for 020_p3a_procedure_hardening.sql

DROP TRIGGER IF EXISTS procedure_def_active_immutable ON procedure_definitions;
DROP FUNCTION IF EXISTS enforce_active_procedure_immutability();

DROP TABLE IF EXISTS procedure_status_events;

DROP INDEX IF EXISTS procedure_def_active_uniq_idx;
DROP INDEX IF EXISTS procedure_def_source_candidate_idx;

CREATE INDEX procedure_def_active_idx
  ON procedure_definitions(tenant_id, agent_id, nome) WHERE status = 'active';
CREATE INDEX procedure_def_source_candidate_idx
  ON procedure_definitions(source_candidate_id) WHERE source_candidate_id IS NOT NULL;
