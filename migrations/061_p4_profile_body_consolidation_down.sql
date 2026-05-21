-- Reverse of 061: backfill legacy content columns from profile_body, then
-- drop profile_body and restore an append-only guard for the legacy columns.
--
-- Why we backfill BEFORE dropping (Codex review #163 round 6, [high]):
--   After 061 lands, every new row written by
--   `operationalProfileVersionsRepo.create` carries data only inside
--   `profile_body` (the legacy columns get the column default `'{}'::jsonb`).
--   A naive `DROP COLUMN profile_body` would erase those rows' identity
--   payload entirely — runtime renderer + drift detectors would see blank
--   content for any profile version created post-061.
--
--   Strategy: before the DROP, copy the direct-embed legacy keys back into
--   the four legacy columns. For canonical-only rows (no direct-embed but
--   `profile_body.identity` populated), synthesize plausible legacy values
--   from canonical identity.* — same lossy mapping the resolver uses in
--   reverse, so at minimum identity_block, principles, voice_descriptor,
--   and thresholds survive the rollback.
--
-- Why we install a legacy-only append-only trigger (Codex review #163
-- round 5, [medium]):
--   Without it, direct SQL could mutate core_immutable / operational_profile
--   / episodic_temp / growth_backlog on the post-rollback schema, breaking
--   the append-only invariant.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DO $outer$
DECLARE
  has_legacy boolean;
  has_profile_body boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'profile_body'
  ) INTO has_profile_body;

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'core_immutable'
  ) INTO has_legacy;

  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  -- (1) Backfill the legacy content columns from profile_body before the
  -- DROP, so post-061 rows don't lose their identity payload on rollback.
  IF has_profile_body AND has_legacy THEN
    EXECUTE $sql$
      UPDATE agent_operational_profile_versions
         SET core_immutable = CASE
               -- Prefer the direct-embed mirror that migration 061 + the
               -- proposal-generator both write.
               WHEN profile_body->'core_immutable' IS NOT NULL
                AND profile_body->'core_immutable' <> '{}'::jsonb
                 THEN profile_body->'core_immutable'
               -- Fallback: synthesize from canonical identity.*. Lossy but
               -- preserves identity_block + principles for the renderer.
               WHEN profile_body->'identity' IS NOT NULL
                 THEN jsonb_build_object(
                   'identity_block', COALESCE(
                     profile_body->'identity'->>'identity_block',
                     profile_body->'identity'->>'role_descriptor',
                     ''
                   ),
                   'principles', COALESCE(
                     profile_body->'identity'->'principles',
                     profile_body->'identity'->'priorities',
                     '[]'::jsonb
                   )
                 )
               ELSE core_immutable
             END,
             operational_profile = CASE
               WHEN profile_body->'operational_profile' IS NOT NULL
                AND profile_body->'operational_profile' <> '{}'::jsonb
                 THEN profile_body->'operational_profile'
               WHEN profile_body->'identity'->'voice' IS NOT NULL
                 THEN jsonb_build_object(
                   'voice_descriptor', COALESCE(
                     profile_body->'identity'->'voice'->>'tone',
                     ''
                   ),
                   'thresholds', COALESCE(
                     profile_body->'identity'->'cognitive_limits',
                     '{}'::jsonb
                   )
                 )
               ELSE operational_profile
             END,
             episodic_temp = CASE
               WHEN profile_body->'episodic_temp' IS NOT NULL
                AND profile_body->'episodic_temp' <> '{}'::jsonb
                 THEN profile_body->'episodic_temp'
               ELSE episodic_temp
             END,
             growth_backlog = CASE
               WHEN profile_body->'growth_backlog' IS NOT NULL
                AND jsonb_typeof(profile_body->'growth_backlog') = 'array'
                AND jsonb_array_length(profile_body->'growth_backlog') > 0
                 THEN profile_body->'growth_backlog'
               ELSE growth_backlog
             END
       WHERE profile_body IS NOT NULL
         AND profile_body <> '{}'::jsonb
    $sql$;
  END IF;

  -- (2) Drop the profile_body column.
  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             DROP COLUMN IF EXISTS profile_body';

  -- (3) Reinstall an append-only guard for the legacy columns so the
  -- post-rollback table preserves the invariant.
  IF has_legacy THEN
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
