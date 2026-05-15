-- Down for migration 026 — restore the original CHECK from migration 021.
--
-- WARNING: any rows with event_type IN ('auto_abandoned', 'human_confirmation')
-- would violate the restored CHECK. We delete them first to keep the down
-- script safe to run on environments where the new values were used.
-- This loses some audit trail; only run the down if you also rolled back the
-- reaper / human_confirmed evaluator code that emitted those rows.
--
-- Runtime contract: `_down.sql` files are NOT run by `scripts/migrate.ts`
-- (it filters them out — see migrate.ts:16-17). They are executed manually
-- via `psql -f`, and `psql` does NOT auto-wrap a multi-statement file in a
-- transaction — each statement autocommits on its own. So we wrap the whole
-- file in an explicit BEGIN/COMMIT and take an EXCLUSIVE lock on the table
-- to fence concurrent inserts: if the script is interrupted between the
-- DELETE/DROP/ADD, the transaction aborts and the table is left with the
-- original CHECK and rows intact, instead of audit data lost AND no CHECK
-- at all.
--
-- Operator note: you can also invoke via `psql -1 -f <file>` (single
-- transaction mode) for belt-and-suspenders; the explicit BEGIN/COMMIT
-- below makes that flag redundant but harmless.

BEGIN;

LOCK TABLE procedure_execution_events IN EXCLUSIVE MODE;

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

COMMIT;
