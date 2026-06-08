-- Reverse 083: restore `DEFAULT 'default'` on the EXPLICIT set of columns that
-- carried it.
--
-- Why an explicit hardcoded list (not re-discovery): post-drop, a
-- `column_default LIKE '''default''%'` query finds NOTHING (the defaults are
-- already gone), and discovery-by-name would OVER-restore columns that were
-- always strict (e.g. channels.tenant_id — NOT NULL, never had a default). Once
-- dropped, the live schema cannot distinguish "had the default" from "always
-- strict", so the down must use the set captured at authoring time. This mirrors
-- the 009_..._down precedent (which hardcodes its 27-table array).
--
-- Set = 009's 27 MINUS dashboard_sessions (dropped by 062) PLUS the later
-- default-bearing tables: 008, 063, 068, 071 (×4 scheduling), 074, 076.
-- Each ALTER is guarded by a column-existence check so a since-dropped
-- table/column is a safe no-op.

DO $$
DECLARE
  t TEXT;
  col TEXT;
  tables TEXT[] := ARRAY[
    -- 009's 27, minus dashboard_sessions (dropped by 062)
    'entidades','contas_bancarias','categorias','transacoes',
    'transferencias_internas','recorrencias','contrapartes',
    'pessoas','permission_profiles','permissoes','conversas','mensagens',
    'agent_facts','learned_rules','agent_memories','self_state',
    'entity_states','workflows','workflow_steps','pending_questions',
    'idempotency_keys','system_health_events','dead_letter_jobs',
    'import_runs','import_entries','audit_log',
    -- later default-bearing tables
    'cognitive_module_log','outbound_messages','idempotency_effect_outbox',
    'series','occurrences','tasks','outbox_messages',
    'agent_audience_profiles','agent_tool_grants'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOREACH col IN ARRAY ARRAY['tenant_id','agent_id'] LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name = col
      ) THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT ''default''', t, col);
      END IF;
    END LOOP;
  END LOOP;
END $$;
