-- P84-C2 rollback: drop the partial UNIQUE index that prevents duplicate
-- in_progress executions on the same conversa.

DROP INDEX IF EXISTS procedure_exec_one_in_progress_per_conversa;
