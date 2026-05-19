-- P8b review: unique constraint on soul_biases.proposal_id (non-null) to
-- enforce replay-safe idempotency at the DB level. Prevents a re-replay of
-- an approved capability_proposal from creating a second materialization when
-- the first has already been rolled_back or deprecated.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE UNIQUE INDEX soul_biases_proposal_id_unique_idx
  ON soul_biases (proposal_id)
  WHERE proposal_id IS NOT NULL;
