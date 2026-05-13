-- P2 (PR #82 review): corrige isolamento de agent_facts.
--
-- A migration 001 criou UNIQUE (escopo, chave) global. Em multi-tenant isso
-- permite que tenant B faça upsert da mesma chave e sobrescreva o fato do
-- tenant A — mesmo com as leituras já filtrando por tenant/agent (Codex
-- adversarial review on PR #82, finding [high] em src/db/repositories.ts).
--
-- A correção promove a unicidade para (tenant_id, agent_id, escopo, chave).
-- Esta migration roda APÓS 012 (NOT NULL em tenant_id/agent_id), então as
-- colunas já são garantidas pelo schema. O onConflictDoUpdate em factsRepo
-- foi atualizado em conjunto para apontar para o novo conflict target.
--
-- NOTE: este slot (018) é estritamente posterior aos artefatos já mergeados
-- da branch P2 (013_p1..017_p2_migrate_legacy_facts). Em uma reconciliação
-- futura com a versão renumerada da PR #81 (que reservou 013_p0_agent_facts_
-- tenant_unique), esta migration deve ser absorvida.

ALTER TABLE agent_facts DROP CONSTRAINT IF EXISTS agent_facts_escopo_chave_key;

ALTER TABLE agent_facts
  ADD CONSTRAINT agent_facts_tenant_agent_escopo_chave_key
  UNIQUE (tenant_id, agent_id, escopo, chave);
