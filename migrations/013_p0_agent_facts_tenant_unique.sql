-- P0: corrige isolamento de agent_facts.
--
-- A migration 001 criou UNIQUE (escopo, chave) global. Em multi-tenant isso
-- permite que tenant B faça upsert da mesma chave e sobrescreva o fato do
-- tenant A — mesmo com as leituras já filtrando por tenant/agent.
--
-- A correção promove a unicidade para (tenant_id, agent_id, escopo, chave).
-- Esta migration roda APÓS 012 (NOT NULL), então tenant_id/agent_id já são
-- garantidos pelo schema.

ALTER TABLE agent_facts DROP CONSTRAINT IF EXISTS agent_facts_escopo_chave_key;

ALTER TABLE agent_facts
  ADD CONSTRAINT agent_facts_tenant_agent_escopo_chave_key
  UNIQUE (tenant_id, agent_id, escopo, chave);
