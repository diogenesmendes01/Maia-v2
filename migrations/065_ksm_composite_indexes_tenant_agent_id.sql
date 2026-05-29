-- maia:no-transaction
-- =====================================================================
-- Maia — Migration 065 (Issue #281)
-- KSM lifecycle partial indexes for the auto-promoter hot path on all
-- four knowledge tables: agent_facts, memory_entry, behavioral_hint,
-- learned_rules.
--
-- Origin & redesign (PR #310 Codex review, reval blockers B1/B2/B3)
-- -----------------------------------------------------------------
-- The first cut of this migration created `(tenant_id, agent_id, id)`
-- composite indexes to "help" the KSM facade's
-- `findById`/`update`/probe queries
-- (src/control-plane/knowledge-state-machine/repos.ts), which filter by:
--
--   WHERE id = $1 AND tenant_id = $2 AND agent_id = $3
--
-- That was redundant: `id` is the PRIMARY KEY (a defaultRandom() UUID),
-- so the existing PK index already locates exactly ONE row and Postgres
-- applies tenant_id/agent_id as a cheap filter on that single heap
-- tuple. A `(tenant_id, agent_id, id)` index cannot beat a unique PK
-- lookup for a single-row fetch — it only adds write amplification.
--
-- The REAL hot path is the auto-promoter
-- (src/workers/knowledge-state-promoter.ts), which runs hourly and, for
-- each of the four tables, calls `listEligible`:
--
--   WHERE lifecycle_status = $1 AND <updated_at / evidence filter>
--   LIMIT 100
--
-- None of the (tenant_id, agent_id, id) indexes have lifecycle_status as
-- a leading column, so they did nothing for the promoter. The tables are
-- dominated by lifecycle_status='active' rows (legacy upsert paths write
-- 'active' by DB default), while the promoter sweeps the rare in-flight
-- states. That is exactly what a partial index serves well.
--
-- Index design — two partial indexes per table
-- ---------------------------------------------
-- (1) Transient-states sweep (promoter steps 1-5: ephemeral→observed,
--     observed→reinforced, reinforced→verified, verified→active,
--     ephemeral→deprecated). All filter `lifecycle_status = X` plus an
--     `updated_at` / evidence predicate. A partial index keyed on
--     (lifecycle_status, updated_at) restricted to the four in-flight
--     states stays tiny (excludes the 'active' bulk and the terminal
--     'deprecated'/'revoked' rows): leading lifecycle_status satisfies
--     the equality, updated_at backs the range filter and orders the
--     LIMIT 100.
--
-- (2) Active-deprecation sweep (promoter step 6: active→deprecated,
--     predicate COALESCE(last_recall_at, updated_at) < cutoff). 'active'
--     is the bulk of the table, so status alone is not selective; but a
--     partial index on (lifecycle_status, last_recall_at, updated_at)
--     WHERE lifecycle_status='active' lets the LIMIT 100 walk the oldest
--     rows first and stop early instead of scanning + sorting the heap.
--
-- This covers all four KSM tables (B3: learned_rules was previously
-- omitted) and matches the queries the promoter actually issues (B2).
--
-- Concurrency
-- -----------
-- Every index uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so it can
-- be built against live tables without an ACCESS EXCLUSIVE lock. The
-- `-- maia:no-transaction` marker tells the migration runner
-- (scripts/migrate.ts) to apply this file OUTSIDE a BEGIN/COMMIT
-- envelope (PostgreSQL rejects CONCURRENTLY inside a transaction block
-- with error 25001).
--
-- Multi-statement note (PR #310 CI fix)
-- -------------------------------------
-- This is the first no-transaction migration with MULTIPLE statements.
-- node-postgres' simple-query protocol wraps multiple statements sent in
-- one `client.query()` call in an IMPLICIT transaction — which made even
-- the no-tx path trip "CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block". Both scripts/migrate.ts and the testcontainer
-- fixture now split no-tx files on `;` and execute each statement
-- separately. Statements here MUST therefore stay one-per-`;`,
-- single-line-terminated (no `;` inside an individual statement).
--
-- Idempotency
-- -----------
-- Each statement uses IF NOT EXISTS so re-runs are no-ops. If the runner
-- crashes between statements, the next run picks up where it left off
-- (schema_migrations insert uses ON CONFLICT DO NOTHING — see
-- scripts/migrate.ts).
--
-- WARNING — manual application
-- ----------------------------
-- If applying this file manually via `psql -f`, do NOT wrap it in
-- BEGIN/COMMIT (psql runs each statement autonomously, which is fine).
-- The runner already handles the no-tx semantics via the marker above.
-- =====================================================================

-- agent_facts -----------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_facts_lifecycle_inflight
  ON agent_facts (lifecycle_status, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_facts_lifecycle_active
  ON agent_facts (lifecycle_status, last_recall_at, updated_at)
  WHERE lifecycle_status = 'active';

-- memory_entry ----------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_entry_lifecycle_inflight
  ON memory_entry (lifecycle_status, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_entry_lifecycle_active
  ON memory_entry (lifecycle_status, last_recall_at, updated_at)
  WHERE lifecycle_status = 'active';

-- behavioral_hint -------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_behavioral_hint_lifecycle_inflight
  ON behavioral_hint (lifecycle_status, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_behavioral_hint_lifecycle_active
  ON behavioral_hint (lifecycle_status, last_recall_at, updated_at)
  WHERE lifecycle_status = 'active';

-- learned_rules ---------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_learned_rules_lifecycle_inflight
  ON learned_rules (lifecycle_status, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_learned_rules_lifecycle_active
  ON learned_rules (lifecycle_status, last_recall_at, updated_at)
  WHERE lifecycle_status = 'active';
