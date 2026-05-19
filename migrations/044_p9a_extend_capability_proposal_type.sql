-- P9a: estende CHECK de capability_proposals.capability_type para 'skill'.
-- Antecipa P8e ('soul_bias') e P9b ('policy_rule') também, sem ativar uso.

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other',
    'skill', 'soul_bias', 'policy_rule', 'holiday'
  ));
