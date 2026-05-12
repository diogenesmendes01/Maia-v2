-- Down migration for 007_scheduling.sql

DROP INDEX IF EXISTS idx_audit_log_occurrence;
ALTER TABLE audit_log DROP COLUMN IF EXISTS occurrence_id;

DROP INDEX IF EXISTS idx_outbox_dedup;
DROP INDEX IF EXISTS idx_outbox_due;
DROP TABLE IF EXISTS outbox_messages;

DROP TABLE IF EXISTS tasks;

DROP INDEX IF EXISTS idx_occurrences_correlation;
DROP INDEX IF EXISTS idx_occurrences_series_status;
DROP INDEX IF EXISTS idx_occurrences_due;
DROP TABLE IF EXISTS occurrences;

DROP INDEX IF EXISTS idx_series_active;
DROP TABLE IF EXISTS series;
