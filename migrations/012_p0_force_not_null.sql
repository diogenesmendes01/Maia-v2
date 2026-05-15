-- P0: força NOT NULL em tenant_id e agent_id em todas as 27 tabelas relevantes
-- Backfill DEVE ter rodado antes (migration 010); se houver NULL, ALTER falha.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

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
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN agent_id SET NOT NULL',
      t
    );
  END LOOP;
END $$;
