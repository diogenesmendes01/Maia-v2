-- Reverte 036c: volta para 5 tipos originais de 028_p5_capability_proposals.sql.
ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check CHECK (
    capability_type IN ('tool', 'knowledge', 'procedure', 'integration', 'other')
  );
