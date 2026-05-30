-- maia:no-transaction
-- Down migration for 073_scheduling_tenant_indexes.sql
-- WARNING: destructive — drops the tenant/agent-led partial indexes and
-- restores the original (non-tenant-led) shapes from 007_scheduling.sql.
--
-- Mirrors the up migration: DROP/CREATE INDEX CONCURRENTLY so it runs
-- against the live tables without an ACCESS EXCLUSIVE lock. PostgreSQL
-- rejects CONCURRENTLY inside a transaction block, hence the
-- `maia:no-transaction` marker. Every statement is single, `;`-
-- terminated, IF [NOT] EXISTS for idempotent re-runs, no embedded `;`.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain
-- only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. If applying manually, do NOT wrap this
-- file in BEGIN/COMMIT.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_series_active;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_series_active ON series (owner_pessoa_id) WHERE status = 'active';

DROP INDEX CONCURRENTLY IF EXISTS idx_occurrences_due;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_occurrences_due ON occurrences (scheduled_for) WHERE status IN ('pending', 'claimed');

DROP INDEX CONCURRENTLY IF EXISTS idx_occurrences_correlation;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_occurrences_correlation ON occurrences (correlation_token) WHERE correlation_token IS NOT NULL AND status IN ('awaiting_third_party', 'in_progress');

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_due;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_due ON outbox_messages (next_attempt_at) WHERE status IN ('pending', 'claimed');
