-- P84-C2: prevent duplicate concurrent in_progress executions on the same conversa.
--
-- Before this index, two inbound messages for the same conversa landing in
-- worker processes in parallel could both observe `findActiveForConversa = null`
-- and both call `startExecution`, producing two concurrent `in_progress` rows.
-- The post-turn evaluator then mutates whichever it grabbed first, leaving the
-- other zombie. With message-recovery and DLQ replay both active in this
-- codebase, that race is reachable in production.
--
-- The partial UNIQUE index closes the race at the database level: the second
-- INSERT fails with a unique-violation, and the application layer
-- (procedureExecutionsRepo.createOrFindActive) handles the conflict by
-- re-loading the active row instead of creating a duplicate.
--
-- Scope: only `status='in_progress'` rows and only when `conversa_id IS NOT NULL`.
-- Completed/aborted rows are allowed to repeat freely (history). Null-conversa
-- executions (background runs) are not affected and remain unique-free.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE UNIQUE INDEX procedure_exec_one_in_progress_per_conversa
  ON procedure_executions (tenant_id, agent_id, conversa_id)
  WHERE status = 'in_progress' AND conversa_id IS NOT NULL;
