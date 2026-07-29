-- 101 down — drop the attempt-grouping columns (issue #514, review round 2).
--
-- Reverting loses only the DENORMALISED grouping. Nothing else depends on it:
-- the envelope HMAC never covered these columns, and `turno_id` (which is
-- signed) still identifies the turn, so a rolled-back deployment can still
-- correlate attempts — just less directly.
--
-- Index first, then the constraint, then the columns: dropping the columns
-- would cascade the index anyway, but the explicit order keeps the down
-- readable and makes a partial failure easier to diagnose.

DROP INDEX IF EXISTS runtime_trace_env_attempt_group_idx;

ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_attempt_chk;

ALTER TABLE runtime_trace_envelopes
  DROP COLUMN IF EXISTS attempt,
  DROP COLUMN IF EXISTS root_trace_id;
