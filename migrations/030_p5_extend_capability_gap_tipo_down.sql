-- Cuidado: ao reverter, qualquer row com tipo='technical' viola o constraint antigo.
-- DOWN remove rows 'technical' antes de restaurar o constraint.
DELETE FROM agent_capability_gaps WHERE tipo = 'technical';

ALTER TABLE agent_capability_gaps DROP CONSTRAINT IF EXISTS agent_capability_gaps_tipo_check;

ALTER TABLE agent_capability_gaps ADD CONSTRAINT agent_capability_gaps_tipo_check
  CHECK (tipo IN ('tool', 'knowledge', 'procedure'));
