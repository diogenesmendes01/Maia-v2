-- Down migration for 111_schema_migration_events.sql
-- WARNING: destructive — review before applying. Run in transaction.
--
-- Drops the append-only migration event trail. This DESTROYS the record of
-- every repair that was ever performed — who declared a dirty migration done,
-- when, and why. Export it before dropping if any repair has been recorded:
--
--   \copy (SELECT * FROM schema_migration_events ORDER BY id) TO 'events.csv' CSV HEADER
--
-- The runner tolerates the table's absence (it records events best-effort), so
-- dropping this does not break `maia migrate up` — it only makes the next
-- incident harder to reconstruct.

BEGIN;

DROP INDEX IF EXISTS schema_migration_events_migration_idx;
DROP INDEX IF EXISTS schema_migration_events_occurred_idx;
DROP TABLE IF EXISTS schema_migration_events;

COMMIT;
