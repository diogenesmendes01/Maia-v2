-- P0: adiciona tenant_id e agent_id (nullable, default 'default') em todas as 27 tabelas relevantes
-- NOTE: no BEGIN/COMMIT wrappers — migrate.ts already wraps in transaction.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT ''default'' REFERENCES tenants(id)',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT ''default'' REFERENCES agents(id)',
      t
    );
  END LOOP;
END $$;
