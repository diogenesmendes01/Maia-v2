-- Down migration for 108_schema_migrations_v2.sql
-- WARNING: destructive — review before applying. Run in transaction.
--
-- Reverts the ledger to its v1 shape (id + applied_at). This DISCARDS the
-- applied history's checksums, states, timings and repair trail — the applied
-- migration list itself survives, which is what the v1 runner needs to keep
-- skipping already-applied files.
--
-- Two things to know before running this:
--
--   1. Any row currently in a non-`applied` state (running / dirty / failed)
--      becomes indistinguishable from a healthy one once `status` is dropped.
--      Resolve dirty rows FIRST (`tsx scripts/migrate.ts repair ...`), or the
--      v1 runner will silently skip a half-applied migration.
--   2. Rows with a NULL applied_at (an in-flight `running` row) would violate
--      the restored NOT NULL, so they are stamped with now() first. Prefer
--      resolving them properly over letting this line paper over them.
--
-- Restoring NOT NULL is best-effort: it is what v1 had, and the v2 runner
-- re-drops it on its next bootstrap.

BEGIN;

UPDATE schema_migrations SET applied_at = now() WHERE applied_at IS NULL;

ALTER TABLE schema_migrations DROP CONSTRAINT IF EXISTS schema_migrations_status_check;
ALTER TABLE schema_migrations DROP CONSTRAINT IF EXISTS schema_migrations_checksum_source_check;

ALTER TABLE schema_migrations
  DROP COLUMN IF EXISTS checksum_sha256,
  DROP COLUMN IF EXISTS checksum_source,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS execution_ms,
  DROP COLUMN IF EXISTS app_version,
  DROP COLUMN IF EXISTS runner_version,
  DROP COLUMN IF EXISTS error_class,
  DROP COLUMN IF EXISTS repaired_at,
  DROP COLUMN IF EXISTS repair_reason;

ALTER TABLE schema_migrations ALTER COLUMN applied_at SET NOT NULL;

COMMIT;
