-- Down migration for 071_scheduling_add_tenant_agent.sql
-- WARNING: destructive — drops tenant_id / agent_id from the four
-- scheduling tables (and the data backfilled into them by 072).
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. Dropping these columns makes the 072
-- backfill rollback irrelevant (the values disappear with the column).

ALTER TABLE outbox_messages
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS agent_id;

ALTER TABLE tasks
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS agent_id;

ALTER TABLE occurrences
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS agent_id;

ALTER TABLE series
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS agent_id;
