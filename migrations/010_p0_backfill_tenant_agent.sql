-- P0: backfill rows existentes pra tenant_id='default', agent_id='default'
-- Em batches pra não travar DB; pode rodar várias vezes sem efeito colateral.
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
  rows_updated INTEGER;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''default'' WHERE tenant_id IS NULL',
      t
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled tenant_id em %: % rows', t, rows_updated;

    EXECUTE format(
      'UPDATE %I SET agent_id = ''default'' WHERE agent_id IS NULL',
      t
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled agent_id em %: % rows', t, rows_updated;
  END LOOP;
END $$;

-- Validação: nenhuma row deve ter NULL após backfill
DO $$
DECLARE
  t TEXT;
  null_count INTEGER;
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
      'SELECT count(*) FROM %I WHERE tenant_id IS NULL OR agent_id IS NULL',
      t
    ) INTO null_count;
    IF null_count > 0 THEN
      RAISE EXCEPTION 'Backfill falhou: tabela % ainda tem % rows com NULL', t, null_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'Backfill validado: zero NULLs em todas as tabelas';
END $$;
