DROP INDEX IF EXISTS idx_procedure_definitions_domain;
ALTER TABLE procedure_definitions DROP COLUMN IF EXISTS domain;
