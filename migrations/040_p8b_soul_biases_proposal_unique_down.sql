-- Down for 040: remove the unique partial index on proposal_id.
DROP INDEX IF EXISTS soul_biases_proposal_id_unique_idx;
