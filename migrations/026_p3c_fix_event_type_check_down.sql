-- Down for migration 026 — restore the original CHECK from migration 021.
--
-- WARNING: any rows with event_type IN ('auto_abandoned', 'human_confirmation')
-- would violate the restored CHECK. We delete them first to keep the down
-- script safe to run on environments where the new values were used.
-- This loses some audit trail; only run the down if you also rolled back the
-- reaper / human_confirmed evaluator code that emitted those rows.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DELETE FROM procedure_execution_events
WHERE event_type IN ('auto_abandoned', 'human_confirmation');

ALTER TABLE procedure_execution_events
  DROP CONSTRAINT procedure_execution_events_event_type_check;

ALTER TABLE procedure_execution_events
  ADD CONSTRAINT procedure_execution_events_event_type_check
  CHECK (event_type IN (
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
    'execution_abandoned'
  ));
