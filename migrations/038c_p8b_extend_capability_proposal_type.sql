-- P8b: Estende capability_type para incluir 'soul_bias'.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.
ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check CHECK (
    capability_type IN (
      'tool', 'knowledge', 'procedure', 'integration',
      'skill', 'soul_bias', 'policy_rule', 'holiday', 'other'
    )
  );
