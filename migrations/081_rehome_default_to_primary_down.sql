-- Reverse 081: move data back from `primary` to `default`, same discovery union.
--
-- In the full down chain this runs AFTER 083_down (which re-seeds the `default`
-- tenant/agent rows), so the FK targets exist, and BEFORE 080_down (which
-- deletes `primary`). Only the `primary` agent/tenant registry rows themselves
-- remain on `primary` afterwards (the agents/tenants tables are excluded), and
-- 080_down removes those.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT t.table_name, t.column_name FROM (
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name IN ('tenant_id', 'agent_id')
      UNION
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
      'UPDATE public.%I SET %I = ''default'' WHERE %I = ''primary''',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;
