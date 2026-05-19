-- LOCK EXCLUSIVE para evitar INSERT concorrente escapar do CHECK restaurado.
BEGIN;

LOCK TABLE capability_proposals IN EXCLUSIVE MODE;

DELETE FROM capability_proposals WHERE capability_type = 'holiday';

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN ('tool', 'knowledge', 'procedure', 'integration', 'other'));

COMMIT;
