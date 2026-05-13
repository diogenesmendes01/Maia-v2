-- P5: estende CHECK constraint de agent_capability_gaps.tipo para incluir 'technical'
-- (usado pelo revert path quando capability falha pós-ativação)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE agent_capability_gaps DROP CONSTRAINT IF EXISTS agent_capability_gaps_tipo_check;

ALTER TABLE agent_capability_gaps ADD CONSTRAINT agent_capability_gaps_tipo_check
  CHECK (tipo IN ('tool', 'knowledge', 'procedure', 'technical'));
