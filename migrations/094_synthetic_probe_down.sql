-- 094 down — reverte as MUDANÇAS ESTRUTURAIS da sonda sintética. Aplicado
-- manualmente via psql (o runner ignora *_down.sql). Idempotente e SEMPRE
-- aplicável — inclusive DEPOIS de a sonda ter executado o agente real.
--
-- Por que estrutural-only (review P1-D): um run REAL do agente escreve em MUITAS
-- tabelas de runtime no tenant da sonda — `cognitive_module_log` (FK NO ACTION
-- para tenants/agents, migração 008), trace, decisões de role, KSM, etc. Tentar
-- apagar o tenant/agente (e toda a cadeia de identidade) exigiria enumerar e
-- deletar TODOS esses filhos na ordem certa — frágil e fadado a quebrar num
-- DELETE bloqueado por FK. Então o down:
--   1. DESATIVA o canal de sonda (para de afetar roteamento/catch-all);
--   2. DROPA as tabelas de estado + a coluna is_synthetic (o que a 094 ADICIONOU
--      ao schema COMPARTILHADO);
--   3. PRESERVA o tenant `__probe__` e seus dados (isolados, namespaced,
--      inertes). Um expurgo completo do tenant, se desejado, é um passo
--      operacional à parte (deletar de toda tabela runtime scoped em __probe__).
--
-- Assim o rollback é reversível de verdade (nunca falha), coerente com a trilha
-- preservada em operação.

-- 1. desativa o canal de sonda (idempotente; a coluna is_synthetic ainda existe
--    aqui, então o predicado a usa como salvaguarda).
UPDATE channels SET active = false, updated_at = now()
 WHERE tenant_id = '__probe__' AND is_synthetic = true;

-- 2. estado durável (FK para tenants ⇒ dropar a TABELA é seguro de qualquer forma).
DROP TABLE IF EXISTS synthetic_probe_runs;
DROP TABLE IF EXISTS synthetic_probe_state;

-- 3. marcador imutável.
ALTER TABLE channels DROP COLUMN IF EXISTS is_synthetic;

-- NOTA: o tenant/agente `__probe__` e o seed (pessoa/entidade/conta/canal/role/
-- policy/permissão/grant) + qualquer tráfego são PRESERVADOS de propósito
-- (isolados; um DELETE falharia por FKs NO ACTION de tabelas de runtime como
-- cognitive_module_log). Para remover tudo, faça um expurgo operacional
-- dedicado do tenant '__probe__'.
