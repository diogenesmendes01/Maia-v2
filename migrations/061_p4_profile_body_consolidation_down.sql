-- Reverse of 061: drop `profile_body` and restore an append-only guard for
-- the legacy content columns that remain on the table.
--
-- Why we install a legacy-only trigger (Codex review #163 round 5, [medium]):
--   The naive rollback path just drops the immutability trigger and the
--   profile_body column. That leaves the four legacy content columns
--   (core_immutable / operational_profile / episodic_temp / growth_backlog)
--   physically present BUT unguarded — direct SQL could rewrite
--   operational identity content without appending a new version or audit
--   trail.
--
--   To preserve the append-only invariant across the rollback, we install
--   a legacy-only variant of the immutability function (the one migration
--   027 would have installed if profile_body had never existed).
--
-- Symmetry with 061: the up migration picks the function body based on
-- whether the legacy columns exist; down does the same so it works on
-- either a "full" post-061 schema or a "post-067-drops-legacy" future
-- schema (where the rollback is a no-op for content guards).
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DO $outer$
DECLARE
  has_legacy boolean;
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             DROP COLUMN IF EXISTS profile_body';

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'core_immutable'
  ) INTO has_legacy;

  IF has_legacy THEN
    -- Install a legacy-only append-only function and re-attach the trigger.
    -- Matches the invariant the table had before v3.1.1 introduced
    -- profile_body, just expressed against the four legacy content columns.
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION agent_op_profile_content_immutable()
      RETURNS trigger AS $body$
      BEGIN
        IF NEW.core_immutable       IS DISTINCT FROM OLD.core_immutable       THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.core_immutable is append-only';
        END IF;
        IF NEW.operational_profile  IS DISTINCT FROM OLD.operational_profile  THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.operational_profile is append-only';
        END IF;
        IF NEW.episodic_temp        IS DISTINCT FROM OLD.episodic_temp        THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.episodic_temp is append-only';
        END IF;
        IF NEW.growth_backlog       IS DISTINCT FROM OLD.growth_backlog       THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.growth_backlog is append-only';
        END IF;
        IF NEW.version              IS DISTINCT FROM OLD.version              THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.version is immutable after insert';
        END IF;
        IF NEW.tenant_id            IS DISTINCT FROM OLD.tenant_id            THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.tenant_id is immutable after insert';
        END IF;
        IF NEW.agent_id             IS DISTINCT FROM OLD.agent_id             THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.agent_id is immutable after insert';
        END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $fn$;

    EXECUTE 'CREATE TRIGGER agent_op_profile_content_immutable_trg
               BEFORE UPDATE ON agent_operational_profile_versions
               FOR EACH ROW
               EXECUTE FUNCTION agent_op_profile_content_immutable()';
  END IF;
  -- If legacy columns are also absent (post-drop future), the table has
  -- no content columns to guard; the trigger function is unused.
END;
$outer$;
