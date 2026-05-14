-- P3c — Issue #91 fix.
--
-- The CHECK constraint on `procedure_execution_events.event_type` defined in
-- migration 021 (P3b) does NOT include two values that P3c code emits:
--
--   * 'auto_abandoned'      — emitted by `src/workers/procedure-execution-reaper.ts`
--                             when an in-progress execution is reaped after TTL.
--   * 'human_confirmation'  — emitted by `src/procedures/engine.ts`
--                             (`recordHumanConfirmation`) for the `human_confirmed`
--                             success criterion (event-sourced approval/rejection).
--
-- Without this fix, every INSERT from those code paths fails with
-- `violates check constraint procedure_execution_events_event_type_check`
-- in production. Unit and integration tests mock the repo so the real Postgres
-- CHECK never fires in CI — bug is latent until the reaper or human_confirmed
-- criterion runs end-to-end.
--
-- Mitigation gating: both code paths are reachable only when
-- FEATURE_PROCEDURE_RUNTIME is on (PR #84). The bug is latent until flip.
--
-- Resolution: DROP + ADD the constraint with the full list. The 15 values from
-- migration 021 are preserved verbatim; the 2 missing values are appended.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE procedure_execution_events
  DROP CONSTRAINT procedure_execution_events_event_type_check;

ALTER TABLE procedure_execution_events
  ADD CONSTRAINT procedure_execution_events_event_type_check
  CHECK (event_type IN (
    -- Original 15 values from migration 021 (P3b)
    'execution_started',
    'step_started',
    'input_received',
    'decision_made',
    'tool_called',
    'tool_result',
    'criterion_checked',
    'step_completed',
    'step_failed',
    'branch_taken',
    'state_updated',
    'execution_completed',
    'execution_aborted',
    'execution_escalated',
    'execution_abandoned',
    -- P3c additions (issue #91)
    'auto_abandoned',
    'human_confirmation'
  ));
