-- issue #323 — re-home all runtime data from the legacy `default` bucket to the
-- reserved `primary` tenant.
--
-- Discovers every column to update as the UNION of:
--   (a) columns named tenant_id / agent_id  — catches no-FK holders
--       (outbound_messages, idempotency_effect_outbox), and
--   (b) columns FK-referencing tenants(id) / agents(id) — catches non-standard
--       FK names (procedure_definitions.owner_agent_id).
-- Name-only discovery would miss owner_agent_id (breaking the 084 delete via FK
-- RESTRICT); FK-only discovery would miss the no-FK tenant_id tables.
--
-- Carries the typed seeds (catch-all channel, role/policy, biases, baseline
-- skills) along, since they live in these scoped tables. Requires 081 (primary
-- must exist for the FK targets). NOTE: no BEGIN/COMMIT — migrate.ts wraps in tx.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT t.table_name, t.column_name FROM (
      -- (a) by name
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name IN ('tenant_id', 'agent_id')
      UNION
      -- (b) by FK to tenants/agents (single-column FKs → conkey[1])
      SELECT cl.relname AS table_name, att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
      JOIN pg_class rf ON rf.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND rf.relname IN ('tenants', 'agents')
    ) t
    WHERE t.table_name NOT IN ('tenants', 'agents')
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET %I = ''primary'' WHERE %I = ''default''',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;
