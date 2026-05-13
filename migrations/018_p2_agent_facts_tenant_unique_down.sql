-- Rollback de 018: volta para o UNIQUE global (escopo, chave).
--
-- ATENÇÃO: se houver linhas com mesma (escopo, chave) em tenants diferentes,
-- este down falha. É comportamento esperado — o operador precisa decidir
-- qual linha sobrevive antes de reverter (a separação tenant é a feature).

ALTER TABLE agent_facts DROP CONSTRAINT IF EXISTS agent_facts_tenant_agent_escopo_chave_key;

ALTER TABLE agent_facts
  ADD CONSTRAINT agent_facts_escopo_chave_key
  UNIQUE (escopo, chave);
