-- issue #323 — drop the `DEFAULT 'default'` column-default from every column
-- that carries it.
--
-- After this, an INSERT omitting tenant_id/agent_id fails NOT NULL instead of
-- silently bucketing the row into `default` — closing the #282 silent
-- fall-through (especially for the two NO-FK tables outbound_messages /
-- idempotency_effect_outbox, whose residual default would otherwise keep
-- re-creating `default` rows). Dynamic discovery by column_default; production
-- writers already stamp tenant via applyTenantGuard, so this only changes the
-- failure mode of tenant-less inserts (loud, not silent).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in tx.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE '''default''%'   -- matches 'default'::text and 'default'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT',
      r.table_name, r.column_name
    );
  END LOOP;
END $$;
