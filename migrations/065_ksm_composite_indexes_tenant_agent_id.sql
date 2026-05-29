-- maia:no-transaction
-- =====================================================================
-- Maia — Migration 065 (Issue #281)
-- KSM composite indexes (tenant_id, agent_id, id) on agent_facts,
-- memory_entry, behavioral_hint.
--
-- Origin
-- ------
-- Surfaced via Codex review of PR #267. After PR #243 / #267, the KSM
-- facade (`src/control-plane/knowledge-state-machine/repos.ts`) scopes
-- every `findById` / `update` by tenant_id + agent_id:
--
--   WHERE id = $1 AND tenant_id = $2 AND agent_id = $3
--
-- The primary key on `id` alone makes Postgres do a PK index scan
-- followed by a filter step on tenant_id/agent_id. Composite indexes
-- with `(tenant_id, agent_id, id)` allow index-only scans on these hot
-- paths (and on the disambiguation re-read probes that fire on
-- expected_previous_status mismatches).
--
-- 4-column variant decision
-- -------------------------
-- The `update` path with `expected_previous_status` adds
-- `AND lifecycle_status = $4` to the WHERE. A 4-column variant
-- `(tenant_id, agent_id, id, lifecycle_status)` was considered but
-- intentionally skipped: the 3-column index already locates exactly
-- one row (id is UUID-unique within tenant+agent), so filtering by
-- lifecycle_status post-lookup is a single-column predicate on the
-- located heap tuple — adding lifecycle_status to the index would be
-- pure write amplification without measurable read benefit. See PR
-- body for full reasoning.
--
-- Concurrency
-- -----------
-- All three indexes use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so
-- they can be built against live tables without blocking writes. The
-- `-- maia:no-transaction` marker tells scripts/migrate.ts to apply
-- this file outside a BEGIN/COMMIT envelope (PostgreSQL rejects
-- CONCURRENTLY inside a transaction block with error 25001).
--
-- Idempotency
-- -----------
-- Each statement uses IF NOT EXISTS so re-runs are no-ops. If the
-- migration runner crashes between statements, the next run picks up
-- where it left off (and the schema_migrations row insert uses
-- ON CONFLICT DO NOTHING — see scripts/migrate.ts).
--
-- WARNING — manual application
-- ----------------------------
-- If applying this file manually via `psql -f`, do NOT wrap it in
-- BEGIN/COMMIT. The runner already handles this via the marker above.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_facts_tenant_agent_id
  ON agent_facts (tenant_id, agent_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_entry_tenant_agent_id
  ON memory_entry (tenant_id, agent_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_behavioral_hint_tenant_agent_id
  ON behavioral_hint (tenant_id, agent_id, id);
