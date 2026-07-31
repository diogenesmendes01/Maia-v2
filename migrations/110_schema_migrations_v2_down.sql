-- Down migration for 110_schema_migrations_v2.sql
-- WARNING: destructive — review before applying. Run in transaction.
--
-- Reverts the ledger to its v1 shape (id + applied_at). This DISCARDS every
-- checksum, every status and the whole execution history — after running it,
-- nobody can tell whether a merged migration was edited, and a `dirty` row
-- becomes indistinguishable from a successful one.
--
-- Only run this as part of rolling back to a pre-#516 release, and only after
-- confirming `SELECT id FROM schema_migrations WHERE status <> 'applied'`
-- returns no rows — a dirty row that gets its status dropped is a partially
-- applied schema that the old runner will happily treat as done.
--
-- `applied_at` gets its NOT NULL back, so any row still lacking one (a
-- `running` row) is stamped first. That stamp is a LIE about when it was
-- applied and is exactly why the check above is not optional.

BEGIN;

UPDATE schema_migrations SET applied_at = now() WHERE applied_at IS NULL;

DROP INDEX IF EXISTS schema_migrations_unhealthy_idx;

ALTER TABLE schema_migrations DROP CONSTRAINT IF EXISTS schema_migrations_status_check;

ALTER TABLE schema_migrations
  DROP COLUMN IF EXISTS checksum_sha256,
  DROP COLUMN IF EXISTS checksum_source,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS execution_ms,
  DROP COLUMN IF EXISTS app_version,
  DROP COLUMN IF EXISTS runner_version,
  DROP COLUMN IF EXISTS error_class;

ALTER TABLE schema_migrations ALTER COLUMN applied_at SET NOT NULL;

COMMIT;
