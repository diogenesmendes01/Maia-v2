-- maia:no-transaction
-- =====================================================================
-- Maia — Migration 073 (flip-readiness Batch A, #323; issue #355)
-- Re-lead the scheduling hot-path partial indexes with (tenant_id,
-- agent_id, ...) so the soon-to-be tenant-scoped queries (Batches B-E)
-- get an index whose leading columns satisfy the tenant/agent equality
-- before the existing range / token predicate.
--
-- Background
-- ----------
-- 007_scheduling.sql created four hot partial indexes WITHOUT any
-- tenant/agent leading column:
--
--   idx_series_active        ON series (owner_pessoa_id)
--                            WHERE status = 'active'
--   idx_occurrences_due      ON occurrences (scheduled_for)
--                            WHERE status IN ('pending','claimed')
--   idx_occurrences_correlation
--                            ON occurrences (correlation_token)
--                            WHERE correlation_token IS NOT NULL
--                              AND status IN ('awaiting_third_party','in_progress')
--   idx_outbox_due           ON outbox_messages (next_attempt_at)
--                            WHERE status IN ('pending','claimed')
--
-- Once 071/072 added tenant_id/agent_id, every scheduling read will be
-- scoped `WHERE tenant_id = $ AND agent_id = $ AND <original predicate>`.
-- The old indexes lack the equality columns, so the planner would have
-- to filter tenant/agent on the heap. This migration DROPs each of the
-- four and recreates it with (tenant_id, agent_id) as the leading
-- columns, keeping the SAME partial WHERE clause and the original
-- ordering column last (so the LIMIT-bounded "due" sweeps still walk
-- the range / token in order, now within a single tenant/agent bucket).
--
-- The two non-listed indexes from 007 (idx_occurrences_series_status,
-- the UNIQUE idx_outbox_dedup) are intentionally left untouched: the
-- former already leads with series_id (occurrence lookups are by series,
-- inherently tenant-bounded) and the latter is a global dedup uniqueness
-- guard that must stay tenant-agnostic.
--
-- SCHEMA-ONLY: indexes only — no query, predicate, or worker changes.
--
-- Concurrency
-- -----------
-- DROP/CREATE INDEX CONCURRENTLY so the rebuild runs against the live
-- scheduling tables without an ACCESS EXCLUSIVE lock (occurrences /
-- outbox_messages are on the dispatcher + relay hot paths). The
-- `-- maia:no-transaction` marker tells the runner (scripts/migrate.ts)
-- to apply this file OUTSIDE a BEGIN/COMMIT envelope — PostgreSQL
-- rejects CONCURRENTLY inside a transaction block (error 25001). Every
-- statement is single, `;`-terminated, IF [NOT] EXISTS for idempotent
-- re-runs, with NO embedded `;` (see scripts/migrate.ts
-- splitNoTxStatements + tests/unit/scripts/migrate-no-tx-split.spec.ts).
--
-- Drop-then-create ordering: we DROP the old index first, then CREATE
-- the tenant-led replacement. A crash between the two leaves the table
-- temporarily without that partial index (queries still work via other
-- indexes / seq-scan); a re-run is safe because DROP ... IF EXISTS and
-- CREATE ... IF NOT EXISTS are both idempotent.
--
-- WARNING — manual application: if running this file via `psql -f`, do
-- NOT wrap it in BEGIN/COMMIT. The runner already handles the no-tx
-- semantics via the marker above.
-- =====================================================================

-- series: active-series lookup, now tenant/agent-led -------------------
DROP INDEX CONCURRENTLY IF EXISTS idx_series_active;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_series_active ON series (tenant_id, agent_id, owner_pessoa_id) WHERE status = 'active';

-- occurrences: due sweep (dispatcher), now tenant/agent-led ------------
DROP INDEX CONCURRENTLY IF EXISTS idx_occurrences_due;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_occurrences_due ON occurrences (tenant_id, agent_id, scheduled_for) WHERE status IN ('pending', 'claimed');

-- occurrences: correlation-token lookup, now tenant/agent-led ----------
DROP INDEX CONCURRENTLY IF EXISTS idx_occurrences_correlation;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_occurrences_correlation ON occurrences (tenant_id, agent_id, correlation_token) WHERE correlation_token IS NOT NULL AND status IN ('awaiting_third_party', 'in_progress');

-- outbox_messages: due relay sweep, now tenant/agent-led --------------
DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_due;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_due ON outbox_messages (tenant_id, agent_id, next_attempt_at) WHERE status IN ('pending', 'claimed');
