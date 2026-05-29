-- Issue #298 — idempotency_keys: atomic reservation via INSERT ON CONFLICT.
--
-- Background
-- ----------
-- Migration 002 created `idempotency_keys` as a write-once cache: a row is
-- inserted ONLY AFTER `tool.handler(args)` returns successfully, and the
-- dispatcher (`src/tools/_dispatcher.ts:154-181`) does a `lookup → handler
-- → store` check-then-act sequence:
--
--     const cached = await idempotencyRepo.lookup(key);
--     if (cached) return cached;
--     result = await tool.handler(args, ...);   -- HTTP POST, DB write, etc
--     await idempotencyRepo.store({ key, resultado: result });
--
-- Two concurrent workers can both miss `lookup` (no row exists yet), both
-- execute `tool.handler` (DUPLICATE SIDE EFFECTS — issue #298), then one
-- inserts and the other silently `onConflictDoNothing`s. The cache is
-- supposed to deduplicate side-effecting tool calls; pre-fix, it only
-- deduplicates the cached READ, not the EXECUTION.
--
-- Option A (atomic reservation) — chosen
-- --------------------------------------
-- Replace the check-then-act with `INSERT … ON CONFLICT DO NOTHING
-- RETURNING (xmax = 0) AS was_inserted`:
--
--   1. Worker A INSERTs (key, state='in_progress', expires_at=now()+TTL,
--      resultado=NULL). `was_inserted=true` ⇒ A owns the reservation and
--      proceeds to execute the handler.
--   2. Worker B INSERTs the same key concurrently. ON CONFLICT DO NOTHING
--      means B's INSERT is a no-op. RETURNING `xmax = 0` returns the
--      EXISTING row's xmax (non-zero ⇒ was_inserted=false). B SELECTs the
--      existing row's `state`/`resultado` and either:
--        - state='completed' ⇒ return cached `resultado` immediately
--        - state='in_progress' ⇒ poll/wait until A completes (bounded by
--          `expires_at`).
--   3. Worker A finishes handler, UPDATEs row to state='completed',
--      resultado=<result>, expires_at=NULL.
--
-- The `was_inserted` flag uses Postgres's xmax trick: on a fresh INSERT,
-- xmax=0 (no tx has overwritten the row yet); on a no-op caused by
-- ON CONFLICT DO NOTHING, xmax is the INSERTing tx's xid (non-zero), so
-- `xmax = 0` cleanly distinguishes "I inserted" from "someone else's row
-- was already there". See PostgreSQL docs on system columns + the
-- standard ON CONFLICT idiom.
--
-- Schema changes
-- --------------
--   1. Add `state TEXT` — 'in_progress' (reservation) or 'completed'
--      (handler returned, resultado stored). Default 'completed' so
--      existing rows (all of which have NON-NULL resultado, since the
--      pre-fix code only inserted after handler success) are correctly
--      classified.
--   2. Add `expires_at TIMESTAMPTZ` NULL — when state='in_progress', the
--      wall-clock deadline past which the reservation is considered
--      abandoned (a crashed worker). Cleanup worker / next caller can
--      reclaim. NULL when state='completed'.
--   3. Make `resultado` nullable — 'in_progress' rows have no result yet.
--      The CHECK constraint enforces "completed ⇒ resultado NOT NULL".
--   4. CHECK constraint on state value (defense-in-depth; Drizzle enums
--      are runtime-only on the app side).
--   5. CHECK constraint on (state, resultado, expires_at) coherence so
--      hand-crafted INSERTs from psql can't produce malformed rows.
--   6. Partial index on `expires_at` WHERE `state = 'in_progress'` —
--      backs the cleanup sweep "DELETE FROM idempotency_keys WHERE
--      state = 'in_progress' AND expires_at < now()" without scanning
--      completed rows (the steady-state majority).
--
-- Coordination with PR #273 (issue #261)
-- --------------------------------------
-- PR #273 (migration 063_p10_idempotency_keys_tenant_pk) landed first,
-- promoting the PRIMARY KEY from (key) to (tenant_id, agent_id, key). This
-- migration touches the SAME table but DIFFERENT columns — adds state /
-- expires_at, alters resultado nullability, adds CHECKs. It does NOT
-- touch the primary key. The atomic-reservation logic in
-- src/db/repositories.ts uses `applyTenantGuard` and pulls tenant_id+
-- agent_id from ALS context, and the ON CONFLICT clause now targets the
-- composite PK directly: `ON CONFLICT (tenant_id, agent_id, key)`.
--
-- Backfill
-- --------
-- Existing rows: all have non-NULL `resultado` (forced by the previous
-- NOT NULL constraint). Defaulting `state` to 'completed' classifies them
-- correctly. `expires_at` stays NULL. No data migration required.
--
-- Atomicity
-- ---------
-- `scripts/migrate.ts` wraps each forward `.sql` (without `-- maia:
-- no-transaction`) in BEGIN/COMMIT. All five ALTER + INDEX statements
-- below land atomically. If any fails, the rollback preserves the
-- pre-migration shape.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE idempotency_keys
  ALTER COLUMN resultado DROP NOT NULL;

-- CHECK: state vocabulary. Defense-in-depth; the repository code only
-- writes one of the two values, but a manual INSERT bypassing the repo
-- shouldn't be able to corrupt the column.
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_check
  CHECK (state IN ('in_progress', 'completed'));

-- CHECK: state/resultado/expires_at coherence.
--   completed ⇒ resultado IS NOT NULL (no half-completed cache hits)
--   in_progress ⇒ resultado IS NULL AND expires_at IS NOT NULL
-- The handler MUST set expires_at on reservation; the markCompleted call
-- MUST clear expires_at and set resultado.
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_coherence_check
  CHECK (
    (state = 'completed' AND resultado IS NOT NULL AND expires_at IS NULL)
    OR
    (state = 'in_progress' AND resultado IS NULL AND expires_at IS NOT NULL)
  );

-- Partial index for stale-reservation cleanup. The cleanup worker runs
-- `DELETE FROM idempotency_keys WHERE state = 'in_progress' AND
-- expires_at < now()` — without this index, that's a full scan over the
-- (much larger) completed-rows population. Partial INDEX keeps the
-- working set tiny since `in_progress` rows are transient.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_in_progress_expires
  ON idempotency_keys (expires_at)
  WHERE state = 'in_progress';
