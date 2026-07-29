-- 101 — group runtime-trace envelopes by turn attempt (issue #514, review round 2).
--
-- Migration 100 (+ `envelopeTraceIdForAttempt`) fixed the primary-key collision
-- that made a retry impossible: attempt 1 keeps the root trace id, attempt N>1
-- gets a deterministic `${root}:attempt:N` derivation. That removed the crash
-- but introduced FRAGMENTATION — the Trace Explorer showed N unrelated traces
-- for one turn and an operator investigating a retry had no way to see they
-- belonged together.
--
-- The relationship existed only in process memory (the correlation ALS). These
-- two columns PERSIST it:
--
--   root_trace_id — the turn's root trace id. Equal to `trace_id` on attempt 1.
--                   Nullable so envelopes written before this migration keep
--                   working; the backfill below sets it for them.
--   attempt       — 1-based ordinal of the attempt.
--
-- NOT part of `envelope_hmac`, deliberately. The signature covers the decision
-- evidence (tenant, agent, decision, side_effect_level, policy_id, conversa_id,
-- turno_id) and adding fields to it would invalidate every envelope already
-- written. Grouping integrity does not depend on these columns: `turno_id` is
-- SIGNED and already identifies the turn authoritatively, so a tampered
-- `attempt` cannot make two turns look like one — it can only mis-order the
-- attempts of a turn whose identity is independently verifiable.
--
-- Additive only: no column dropped, no constraint tightened, no data rewritten
-- beyond the backfill of the two new columns.

ALTER TABLE runtime_trace_envelopes
  ADD COLUMN IF NOT EXISTS root_trace_id UUID,
  ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;

-- An attempt ordinal below 1 is meaningless; the writer clamps, this enforces.
ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_attempt_chk;
ALTER TABLE runtime_trace_envelopes
  ADD CONSTRAINT runtime_trace_env_attempt_chk CHECK (attempt >= 1);

-- Backfill: every pre-existing envelope was written before attempts were
-- modelled, so each is its own root, attempt 1 (which the column default
-- already gives).
UPDATE runtime_trace_envelopes
   SET root_trace_id = trace_id
 WHERE root_trace_id IS NULL;

-- The Explorer's grouping query: "all attempts of this turn, in order",
-- tenant-scoped like every other read. Partial — rows with no root (should be
-- none after the backfill, but a concurrent insert during migration could slip
-- through) are not worth indexing.
CREATE INDEX IF NOT EXISTS runtime_trace_env_attempt_group_idx
  ON runtime_trace_envelopes (tenant_id, root_trace_id, attempt)
  WHERE root_trace_id IS NOT NULL;
