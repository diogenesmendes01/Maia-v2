-- Reverse of 063_agent_memories_cleanup_backup.sql.
--
-- Dropping the quarantine table also drops the only undo path for any
-- reflection-memory-cleanup `--execute` runs whose snapshot rows have
-- NOT yet been restored or purged. Operators rolling back this
-- migration should:
--   1. Inspect `SELECT cleanup_run_id, COUNT(*) FROM agent_memories_cleanup_backup
--      WHERE restored_at IS NULL GROUP BY cleanup_run_id;`
--   2. Run `--undo=<cleanup_run_id>` for any runs they still want to
--      reverse, OR explicitly accept the loss.
--   3. Then run this down migration.
--
-- We do NOT add a guard clause (e.g. RAISE on non-empty unrestored rows)
-- because the operator may legitimately want to discard the snapshot
-- after the retention window (issue #260 runbook suggests 30 days). The
-- guard would block intentional cleanup. Dropping a non-empty table
-- after that point is the explicit operator decision.

DROP INDEX IF EXISTS agent_memories_cleanup_backup_deleted_at_idx;
DROP INDEX IF EXISTS agent_memories_cleanup_backup_bucket_idx;
DROP INDEX IF EXISTS agent_memories_cleanup_backup_run_idx;
DROP TABLE IF EXISTS agent_memories_cleanup_backup;
