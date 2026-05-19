-- Calendar v2 — Migration D: extender capability_proposals.capability_type
-- com 'holiday' para suportar propostas de feriado detectadas pelo pipeline P1+P5.
-- (Plan §Task 4 — adaptado ao schema P5 real, que usa `capability_type` em vez
--  de `proposal_type`.)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN ('tool', 'knowledge', 'procedure', 'integration', 'other', 'holiday'));
