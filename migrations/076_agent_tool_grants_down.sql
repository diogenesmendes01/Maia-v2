-- Down migration for 076_agent_tool_grants.sql
-- WARNING: destructive — drops `agent_tool_grants` (and every backfilled /
-- operator-edited grant). After this, the runtime tool filter falls back to the
-- in-code default grant (baseline.core) for every agent, since no persisted
-- grant rows remain.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain only);
-- they are applied manually via `psql -f` per docs/runbooks/migrations.md.

-- Drop the per-agent grant relation (its trigger + indexes drop with the table).
DROP TABLE IF EXISTS agent_tool_grants;
