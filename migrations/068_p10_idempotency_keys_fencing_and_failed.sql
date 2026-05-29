-- Issue #298 (review iter 1 — blockers B2 + B3) — idempotency_keys:
-- add a fencing token to in-flight reservations and a terminal `failed`
-- state. Builds on migration 064 (state/expires_at + coherence CHECKs).
--
-- B2 — stale-lock reclaim permits double execution
-- ------------------------------------------------
-- Migration 064 reservations carry only a fixed-TTL `expires_at`. When a
-- reservation expires, the NEXT caller can reclaim it (UPDATE … WHERE
-- state='in_progress' AND expires_at < now()). But the ORIGINAL owner — a
-- slow worker still running past the TTL, or one that resumes after a GC
-- pause — has no way to know it was preempted. Its later `markCompleted`
-- would still match (tenant_id, agent_id, key, state='in_progress') and
-- clobber the new owner's reservation. Two executions both "win".
--
-- Fix: every reservation (fresh INSERT or reclaim) stamps a freshly
-- generated `reservation_token` (UUID). `markCompleted`/`releaseReservation`
-- require the caller to present the token they received from `tryReserve`;
-- the UPDATE adds `AND reservation_token = <token>`. A preempted owner holds
-- a STALE token, so its completion is a no-op (0 rows) — it cannot overwrite
-- the row the new owner now owns. This is the classic fencing-token guard
-- (Kleppmann, "How to do distributed locking"): the lock service hands out a
-- monotonic/unique token and the resource write is gated on the current
-- token. We use a UUID rather than a counter because the token only needs to
-- be UNIQUE per (re)acquisition, not globally ordered — a reclaim always
-- mints a new token, so the previous owner's token can never match again.
--
-- B3 — failed reservations must be terminal, not deletable
-- --------------------------------------------------------
-- Migration 064's `releaseReservation` DELETEs the in_progress row on
-- handler failure. The next caller computing the same idempotency key then
-- sees a MISS and re-executes — even if the failed handler already applied a
-- partial side effect. To stop silent re-execution, add a third terminal
-- state `failed`. `releaseReservation` now transitions in_progress→failed
-- (fenced by token) instead of deleting; a subsequent `tryReserve` that
-- collides with a `failed` row reports the failure to the caller rather than
-- re-running the handler. Automatic retry is only safe when the operation is
-- provably not applied — that's a higher-level decision, not a silent cache
-- miss.
--
-- Schema changes
-- --------------
--   1. Add `reservation_token TEXT` NULL. Set when state='in_progress';
--      retained (harmless) once the row reaches a terminal state. NULL for
--      pre-existing rows (all 'completed' from 064's default) — they are
--      never completed/released again, so the absence of a token is fine.
--   2. Replace the state CHECK to allow 'failed'.
--   3. Replace the (state, resultado, expires_at) coherence CHECK to cover
--      the terminal 'failed' shape: resultado IS NULL AND expires_at IS NULL
--      (a failure carries no cached result and is not subject to reclaim).
--   4. The partial cleanup index from 064 (`WHERE state='in_progress'`)
--      stays correct: 'failed' rows are terminal and pruned by the
--      completed/aged sweep, not the in_progress reaper. A separate partial
--      index ages out 'failed' rows by created_at.
--
-- Backfill
-- --------
-- Existing rows are all state='completed' (064 default). Adding a nullable
-- column and widening the CHECK vocabulary requires no data migration —
-- every existing row already satisfies the completed branch of the new
-- coherence CHECK (resultado NOT NULL, expires_at NULL).
--
-- Atomicity
-- ---------
-- `scripts/migrate.ts` wraps each forward `.sql` (without `-- maia:
-- no-transaction`) in BEGIN/COMMIT, so the ADD COLUMN + DROP/ADD CONSTRAINT
-- below land atomically. CREATE INDEX … (non-CONCURRENTLY) is fine inside
-- the tx. If any statement fails, the rollback preserves 064's shape.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS reservation_token TEXT;

-- Widen the state vocabulary to include the terminal 'failed' state.
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_check
  CHECK (state IN ('in_progress', 'completed', 'failed'));

-- Replace the coherence CHECK to cover all three states:
--   completed   ⇒ resultado IS NOT NULL AND expires_at IS NULL
--   in_progress ⇒ resultado IS NULL     AND expires_at IS NOT NULL
--   failed      ⇒ resultado IS NULL     AND expires_at IS NULL
-- (A failed reservation carries no cached result and is NOT reclaimable, so
-- expires_at must be NULL — the in_progress reaper must never touch it.)
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_coherence_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_coherence_check
  CHECK (
    (state = 'completed' AND resultado IS NOT NULL AND expires_at IS NULL)
    OR
    (state = 'in_progress' AND resultado IS NULL AND expires_at IS NOT NULL)
    OR
    (state = 'failed' AND resultado IS NULL AND expires_at IS NULL)
  );

-- Age out terminal 'failed' rows alongside completed ones. Partial index so
-- the cleanup sweep "DELETE … WHERE state='failed' AND created_at < cutoff"
-- doesn't scan the (much larger) completed population.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_failed_created
  ON idempotency_keys (created_at)
  WHERE state = 'failed';
