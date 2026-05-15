-- P0: índices compostos pra queries scoped por tenant/agent
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- Tabelas de alta cardinalidade (queries críticas): índice composto
CREATE INDEX IF NOT EXISTS transacoes_tenant_agent_idx ON transacoes(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mensagens_tenant_agent_idx ON mensagens(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversas_tenant_agent_idx ON conversas(tenant_id, agent_id, ultima_atividade_em DESC);
CREATE INDEX IF NOT EXISTS agent_facts_tenant_agent_idx ON agent_facts(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS learned_rules_tenant_agent_idx ON learned_rules(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_memories_tenant_agent_idx ON agent_memories(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_agent_idx ON audit_log(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflows_tenant_agent_idx ON workflows(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS pessoas_tenant_idx ON pessoas(tenant_id);

-- Outras tabelas: índice simples em tenant_id
CREATE INDEX IF NOT EXISTS entidades_tenant_idx ON entidades(tenant_id);
CREATE INDEX IF NOT EXISTS contas_bancarias_tenant_idx ON contas_bancarias(tenant_id);
CREATE INDEX IF NOT EXISTS categorias_tenant_idx ON categorias(tenant_id);
CREATE INDEX IF NOT EXISTS contrapartes_tenant_idx ON contrapartes(tenant_id);
CREATE INDEX IF NOT EXISTS recorrencias_tenant_idx ON recorrencias(tenant_id);
CREATE INDEX IF NOT EXISTS transferencias_internas_tenant_idx ON transferencias_internas(tenant_id);
CREATE INDEX IF NOT EXISTS self_state_tenant_idx ON self_state(tenant_id);
CREATE INDEX IF NOT EXISTS entity_states_tenant_idx ON entity_states(tenant_id);
CREATE INDEX IF NOT EXISTS workflow_steps_tenant_idx ON workflow_steps(tenant_id);
CREATE INDEX IF NOT EXISTS pending_questions_tenant_idx ON pending_questions(tenant_id);
