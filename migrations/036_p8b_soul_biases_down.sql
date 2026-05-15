-- Down de 036: drop integral.
DROP INDEX IF EXISTS soul_biases_drift_source_idx;
DROP INDEX IF EXISTS soul_biases_proposal_idx;
DROP INDEX IF EXISTS soul_biases_proposed_inbox_idx;
DROP INDEX IF EXISTS soul_biases_active_lookup_idx;
DROP INDEX IF EXISTS soul_biases_one_active_idx;
DROP TABLE IF EXISTS soul_biases;
