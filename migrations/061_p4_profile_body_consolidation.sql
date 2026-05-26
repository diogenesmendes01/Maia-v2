-- P4 (v3.1.1 alignment): add `profile_body` JSONB alongside the four legacy
-- columns and embed the legacy 4-layer payload directly under profile_body
-- (matching what `seedInitialOperationalProfile` already writes).
--
-- Why this migration exists, why it's additive, why direct-embed under
-- profile_body, and why the immutability function guards every retained
-- content column — see the long-form comments preserved through the
-- review history below.
--
-- v3.1.1 background:
--   * Migration 025 created the table with four legacy JSONB columns
--     (core_immutable / operational_profile / episodic_temp / growth_backlog).
--   * The v3.1.1-2026-05-15 refactor introduced a consolidated `profile_body`
--     column in `schema.ts` and `operationalProfileVersionsRepo.create`, but
--     no SQL migration was ever shipped. A fresh `npm run db:migrate` left
--     the table without the new column; any INSERT errored with
--     `column "profile_body" does not exist`.
--
-- Additive design (Codex review #163 round 1):
--   This migration keeps the four legacy columns. They carry data the
--   runtime renderer + drift detectors still read; dropping them would
--   silently degrade active prompts on any tenant with pre-3.1.1 data.
--   The `legacy_mirror` envelope tried in round 2 is gone — both writers
--   (proposal-generator + migration backfill) emit the legacy payload
--   DIRECTLY under profile_body so the renderer reads one shape.
--
-- Trigger generation (Codex review #163 round 5, [high]):
--   The immutability function from migration 027 referenced
--   `NEW.profile_body` only. After 061 the function must also guard the
--   retained legacy columns (round 2, [medium]). BUT — PostgreSQL plpgsql
--   evaluates field refs against NEW/OLD at execution time. Dereferencing
--   a missing column ERRORS, it does not fall through to NULL. So the
--   function body has to match the actual column set of the table:
--
--      * Legacy columns PRESENT  → "full" body (profile_body + 4 legacy).
--      * Legacy columns ABSENT   → "canonical" body (profile_body only).
--
--   We pick the body at migration time by introspecting information_schema
--   and EXECUTE-format the CREATE OR REPLACE FUNCTION accordingly. Both
--   variants enforce the same invariant — content columns are append-only,
--   identity primary keys are immutable.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE agent_operational_profile_versions
  ADD COLUMN IF NOT EXISTS profile_body JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $outer$
DECLARE
  has_legacy boolean;
  has_rollback_archive boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'core_immutable'
  ) INTO has_legacy;

  -- Issue #203: detect the sidecar column written by the down migration
  -- (`_rollback_archive_priorities`). When present, restore
  -- profile_body.identity.priorities from it and clear the sidecar so a
  -- subsequent re-rollback captures a fresh snapshot. The column is NOT
  -- dropped on up — keeping it around makes the down idempotent and lets
  -- a future re-rollback archive again without an extra ADD COLUMN.
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = '_rollback_archive_priorities'
  ) INTO has_rollback_archive;

  -- Drop the existing trigger first so the backfill UPDATE doesn't fire it,
  -- and so we can replace the function body cleanly. The CREATE TRIGGER at
  -- the bottom re-attaches it.
  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  IF has_legacy THEN
    -- "Full" function: guards profile_body + four legacy columns + identity
    -- primary keys. Used while the legacy columns are still on the table.
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION agent_op_profile_content_immutable()
      RETURNS trigger AS $body$
      BEGIN
        IF NEW.profile_body         IS DISTINCT FROM OLD.profile_body         THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.profile_body is append-only (insert a new version row instead of mutating)';
        END IF;
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

    -- Backfill: build profile_body from legacy data with the direct-embed
    -- contract (matches what proposal-generator writes).
    --
    -- IMPORTANT: priorities[] is intentionally left as an empty array even
    -- when core_immutable.principles is non-empty (Codex review #163 round 6,
    -- [P2]). The follow-up `scripts/p8d-migration-priorities.ts` is the
    -- canonical writer for priorities — it slug-extracts from
    -- maia-prompt.md and treats any non-empty identity.priorities array as
    -- "already migrated, skip". Prefilling priorities with the full
    -- human-readable principles strings here would lock those rows out of
    -- the slug migration and leave non-slug priorities flowing into the
    -- context packet + papel-drift path. Keeping priorities empty preserves
    -- the contract: legacy principles stay reachable via
    -- profile_body.core_immutable.principles (direct-embed) AND
    -- profile_body.identity.principles for renderers; identity.priorities
    -- waits for the slug migration.
    EXECUTE $sql$
      UPDATE agent_operational_profile_versions
         SET profile_body = jsonb_build_object(
           'schema_version', 'v3.1.1-2026-05-15',
           'identity', jsonb_build_object(
             'role_descriptor', COALESCE(core_immutable->>'identity_block', ''),
             'identity_block',  COALESCE(core_immutable->>'identity_block', ''),
             'principles',      COALESCE(core_immutable->'principles', '[]'::jsonb),
             'voice', jsonb_build_object(
               'tone',      COALESCE(operational_profile->>'voice_descriptor', ''),
               'formality', 'medium',
               'verbosity', 'medium'
             ),
             'cognitive_limits', jsonb_build_object(
               'max_inference_depth',         3,
               'max_speculation_in_response', 0.2,
               'confidence_floor_for_action', 0.7
             ),
             -- Empty array — see comment above; p8d-migration-priorities
             -- is the canonical writer for slug-extracted priorities.
             'priorities', '[]'::jsonb,
             'learned_voice_modifiers', '[]'::jsonb
           ),
           'style', jsonb_build_object('language', 'pt-BR', 'rhythm', '{}'::jsonb),
           'metadata', jsonb_build_object(
             'effective_from',      COALESCE(activated_at, created_at),
             'created_by',          proposed_by,
             'previous_version_id', NULL,
             'migrated_from_legacy', true
           ),
           'core_immutable',      core_immutable,
           'operational_profile', operational_profile,
           'episodic_temp',       episodic_temp,
           'growth_backlog',      growth_backlog
         )
       WHERE profile_body = '{}'::jsonb
    $sql$;
  ELSE
    -- "Canonical" function: guards profile_body + identity primary keys
    -- only. Used when the four legacy columns are absent (a future schema
    -- state after they're physically dropped). PostgreSQL would error on
    -- the "full" body if any legacy column reference can't be resolved.
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION agent_op_profile_content_immutable()
      RETURNS trigger AS $body$
      BEGIN
        IF NEW.profile_body  IS DISTINCT FROM OLD.profile_body  THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.profile_body is append-only (insert a new version row instead of mutating)';
        END IF;
        IF NEW.version       IS DISTINCT FROM OLD.version       THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.version is immutable after insert';
        END IF;
        IF NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id     THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.tenant_id is immutable after insert';
        END IF;
        IF NEW.agent_id      IS DISTINCT FROM OLD.agent_id      THEN
          RAISE EXCEPTION 'agent_operational_profile_versions.agent_id is immutable after insert';
        END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $fn$;
  END IF;

  -- Issue #203 restore: if the sidecar archive column exists and any row
  -- carries a non-empty `_rollback_archive_priorities.priorities`, merge
  -- those priorities back into `profile_body.identity.priorities`. This
  -- recovers the priorities that the previous down migration parked in
  -- the sidecar so they don't get lost across a down→up cycle.
  --
  -- Why we do NOT drop the sidecar column on up: keeping it around makes
  -- the down idempotent (its `ADD COLUMN IF NOT EXISTS` is a no-op next
  -- time) and lets a future re-rollback archive a fresh snapshot without
  -- another schema change. We DO reset the sidecar to '{}'::jsonb after
  -- restore so the next down captures a clean snapshot rather than
  -- replaying a stale one. Idempotence: a second up call finds the
  -- sidecar already cleared and the UPDATE is a no-op.
  --
  -- Codex review [P2] follow-up: seed `profile_body.identity` BEFORE the
  -- `jsonb_set` on `{identity,priorities}`. PostgreSQL's `jsonb_set` with
  -- `create_missing=true` creates ONLY the leaf key — it does NOT
  -- materialize missing intermediate path segments. On the canonical-only
  -- re-up path (no legacy columns → the backfill UPDATE above is skipped
  -- and `profile_body` stays at its `'{}'::jsonb` default), `profile_body`
  -- has no `identity` key, so a bare `jsonb_set` would leave `profile_body`
  -- unchanged and the subsequent sidecar clear would silently lose the
  -- archived priorities. The `||` merge `jsonb_build_object('identity',
  -- COALESCE(profile_body->'identity', '{}'::jsonb))` is idempotent: when
  -- `identity` already exists it round-trips the same value; when it is
  -- absent, it materialises an empty object so `jsonb_set` can then write
  -- the leaf. The result is always a JSONB object whose `identity` key
  -- exists by the time the priorities are merged in.
  IF has_rollback_archive THEN
    EXECUTE $sql$
      UPDATE agent_operational_profile_versions
         SET profile_body = jsonb_set(
               COALESCE(profile_body, '{}'::jsonb)
                 || jsonb_build_object(
                      'identity',
                      COALESCE(profile_body->'identity', '{}'::jsonb)
                    ),
               '{identity,priorities}',
               _rollback_archive_priorities->'priorities',
               true
             ),
             _rollback_archive_priorities = '{}'::jsonb
       WHERE _rollback_archive_priorities IS NOT NULL
         AND _rollback_archive_priorities <> '{}'::jsonb
         AND jsonb_typeof(_rollback_archive_priorities->'priorities') = 'array'
         AND jsonb_array_length(_rollback_archive_priorities->'priorities') > 0
    $sql$;
  END IF;

  EXECUTE 'CREATE TRIGGER agent_op_profile_content_immutable_trg
             BEFORE UPDATE ON agent_operational_profile_versions
             FOR EACH ROW
             EXECUTE FUNCTION agent_op_profile_content_immutable()';
END;
$outer$;
