-- =====================================================================
-- Maia — Migration 071 (flip-readiness Batch A, #323; issue #355)
-- Add tenant_id / agent_id to the Spec-18 scheduling tables.
--
-- The four scheduling tables created in 007_scheduling.sql
-- (series, occurrences, tasks, outbox_messages) predate the P0
-- tenant/agent invariant and carry NO tenant_id / agent_id. This
-- migration adds both columns, mirroring the sibling P0-scoped tables
-- (pessoas, workflow_steps): `text NOT NULL DEFAULT 'default'` with a
-- FK to tenants(id) / agents(id) — exactly the shape migration 009
-- gave every other relevant table.
--
-- Why NOT NULL + DEFAULT is safe here (vs P0's nullable→backfill→
-- force-NOT-NULL three-step): ADD COLUMN ... NOT NULL DEFAULT '...'
-- fills EVERY existing row with the default in one shot (Postgres ≥11
-- does this as a metadata-only operation — no full table rewrite), so
-- there is never a moment where an existing row holds NULL. Existing
-- rows therefore get 'default' immediately; migration 072 then
-- OVERWRITES that with the REAL tenant derived down the FK chain
-- (owner_pessoa_id → pessoas). The 'default' is just a safe floor.
--
-- The seeded 'default' tenant + 'default' agent rows (migration 007)
-- already exist, so the FK references resolve for every backfilled row.
--
-- SCHEMA-ONLY: this adds columns; it does NOT change any query's read
-- behaviour. The new columns are unread by every scheduling query /
-- worker until later flip-readiness batches scope them.
--
-- NOTE: no BEGIN/COMMIT wrappers — scripts/migrate.ts wraps each
-- forward migration in a transaction (this file has no
-- `-- maia:no-transaction` marker, so it runs inside BEGIN/COMMIT).
-- =====================================================================

ALTER TABLE series
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS agent_id  TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id);

ALTER TABLE occurrences
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS agent_id  TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS agent_id  TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id);

ALTER TABLE outbox_messages
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS agent_id  TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id);
