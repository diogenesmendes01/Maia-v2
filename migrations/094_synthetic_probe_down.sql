-- 094 down — desfaz a sonda sintética por completo. Aplicado manualmente via
-- psql (o runner ignora *_down.sql). Idempotente.
--
-- É um TEARDOWN total: remove TODO o tráfego que o runtime preserva em operação
-- (audit/mensagens/conversas do tenant da sonda) — a preservação vale DURANTE a
-- operação (não apagar no meio de um run), não para o uninstall. A ordem
-- respeita as FKs: `conversas.pessoa_id` e `transacoes.entidade_id`/`conta_id`
-- são ON DELETE RESTRICT, e `audit_log` referencia `mensagens`/`conversas` com
-- NO ACTION — por isso audit → transacoes → mensagens → conversas ANTES de
-- pessoas/entidades/contas.

-- 1. tráfego do tenant da sonda (trilha inclusa) — libera os RESTRICT/NO ACTION.
DELETE FROM audit_log  WHERE tenant_id = '__probe__';
DELETE FROM transacoes WHERE tenant_id = '__probe__';
DELETE FROM mensagens  WHERE tenant_id = '__probe__';
DELETE FROM conversas  WHERE tenant_id = '__probe__';

-- 2. seed (filhos → pais).
DELETE FROM agent_tool_grants        WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM permissoes               WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM contas_bancarias         WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM entidades                WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM agent_audience_profiles  WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM pessoas                  WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM channel_policies         WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM roles                    WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM channels                 WHERE tenant_id = '__probe__' AND agent_id = '__probe__';

-- 3. estado durável (FK para tenants ⇒ dropar antes do tenant).
DROP TABLE IF EXISTS synthetic_probe_runs;
DROP TABLE IF EXISTS synthetic_probe_state;

-- 4. tenant/agente da sonda (por último — FKs acima já removidas).
DELETE FROM agents  WHERE id = '__probe__';
DELETE FROM tenants WHERE id = '__probe__';

-- 5. marcador imutável.
ALTER TABLE channels DROP COLUMN IF EXISTS is_synthetic;
