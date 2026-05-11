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
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS tenant_id', t);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS agent_id', t);
  END LOOP;
END $$;
