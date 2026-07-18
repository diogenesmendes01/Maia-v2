-- 094 down — desfaz a sonda sintética na ordem inversa de dependência.
-- Aplicado manualmente via psql (o runner ignora *_down.sql). Idempotente.
--
-- Ordem: filhos primeiro (grant/permissão/conta/entidade/audience/pessoa/policy/
-- role/canal), depois o tenant/agente, depois as tabelas de estado, e por fim a
-- coluna is_synthetic.

-- seed (filhos → pais).
DELETE FROM agent_tool_grants        WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM permissoes               WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM contas_bancarias         WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM entidades                WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM agent_audience_profiles  WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM pessoas                  WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM channel_policies         WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM roles                    WHERE tenant_id = '__probe__' AND agent_id = '__probe__';
DELETE FROM channels                 WHERE tenant_id = '__probe__' AND agent_id = '__probe__';

-- estado durável.
DROP TABLE IF EXISTS synthetic_probe_runs;
DROP TABLE IF EXISTS synthetic_probe_state;

-- tenant/agente da sonda (por último — FKs acima já removidas).
DELETE FROM agents  WHERE id = '__probe__';
DELETE FROM tenants WHERE id = '__probe__';

-- marcador imutável (após dropar as tabelas de estado; nenhuma outra usa a coluna).
ALTER TABLE channels DROP COLUMN IF EXISTS is_synthetic;
