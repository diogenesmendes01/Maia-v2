-- P4 (v3.1.1 alignment): add `profile_body` JSONB alongside the four legacy
-- columns and embed a `legacy_mirror` snapshot inside it so the runtime
-- renderer can read both shapes through the Drizzle schema.
--
-- Why this migration exists:
--   * Migration 025 created the table with four legacy JSONB columns
--     (core_immutable / operational_profile / episodic_temp / growth_backlog).
--   * The v3.1.1-2026-05-15 refactor introduced a consolidated `profile_body`
--     column in `schema.ts` and `operationalProfileVersionsRepo.create`, but
--     no SQL migration was ever shipped. A fresh `npm run db:migrate` left
--     the table without the new column; any INSERT errored with
--     `column "profile_body" does not exist`. Surfaced while smoke-testing
--     the admin-ui agent-setup flow (PR #163).
--
-- Why ADDITIVE (Codex review #163 round 1, [high]):
--   The first draft dropped the legacy columns. That broke the runtime
--   renderer (`renderOperationalProfile`) which reads them directly: any
--   legacy active profile would have rendered as a near-empty prompt.
--
-- Why `legacy_mirror` embedded inside profile_body (Codex review #163 round
-- 2, [high]):
--   `schema.ts` declares only `profile_body` on the table, so
--   `operationalProfileVersionsRepo.getActive()` (Drizzle `.select().from(...)`)
--   returns rows that contain `profile_body` and nothing else — even though
--   the DB still has the legacy columns physically present. A renderer
--   fallback to top-level row.core_immutable is therefore dead code in
--   production. Embedding the legacy snapshot inside profile_body lets the
--   renderer reach it through the Drizzle-shaped row.
--
-- Why the immutability trigger is rewritten (Codex review #163 round 2,
-- [medium]):
--   The original trigger only compared `NEW.profile_body`. With the legacy
--   columns retained AND copied into profile_body.legacy_mirror, a stray
--   direct SQL update to e.g. `core_immutable` would mutate runtime content
--   without appending a new version or hitting the audit trail. The new
--   trigger function rejects any change to the four legacy content columns
--   too — those columns remain append-only just like profile_body.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE agent_operational_profile_versions
  ADD COLUMN IF NOT EXISTS profile_body JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Rewrite the immutability function to also guard the four legacy content
-- columns. Created with OR REPLACE so it's safe regardless of whether the
-- original trigger function from migration 027 ran already.
CREATE OR REPLACE FUNCTION agent_op_profile_content_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.profile_body         IS DISTINCT FROM OLD.profile_body         THEN
    RAISE EXCEPTION 'agent_operational_profile_versions.profile_body is append-only (insert a new version row instead of mutating)';
  END IF;
  -- v3.1.1: the four legacy content columns are retained for the runtime
  -- renderer; they MUST stay append-only too. If a future migration drops
  -- them, this block becomes inert (column references against a missing
  -- column simply return NULL on both NEW and OLD, so IS DISTINCT FROM
  -- evaluates to false). Until then it's a real append-only guard.
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
  -- Identity primary keys are also locked (same as before).
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
$$ LANGUAGE plpgsql;

-- Backfill: for each row with an empty profile_body, build the canonical
-- ProfileBody shape AND embed `legacy_mirror.{core_immutable,operational_profile,
-- episodic_temp,growth_backlog}` so the Drizzle-shaped (profile_body-only)
-- read in the repo carries the legacy data with it.
--
-- This UPDATE must run while the immutability trigger is dropped (the new
-- one rejects any change to the legacy columns even when they're equal-
-- by-value — `IS DISTINCT FROM` compares NULL-safely so equal-by-value
-- passes, but defense-in-depth: we still drop the trigger to keep this
-- migration's UPDATE path uncoupled from trigger semantics).
DO $$
DECLARE
  has_legacy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'core_immutable'
  ) INTO has_legacy;

  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  IF has_legacy THEN
    EXECUTE $sql$
      UPDATE agent_operational_profile_versions
         SET profile_body = jsonb_build_object(
           'schema_version', 'v3.1.1-2026-05-15',
           'identity', jsonb_build_object(
             'role_descriptor', COALESCE(core_immutable->>'identity_block', ''),
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
             'priorities', COALESCE(core_immutable->'principles', '[]'::jsonb),
             'learned_voice_modifiers', '[]'::jsonb
           ),
           'style', jsonb_build_object('language', 'pt-BR', 'rhythm', '{}'::jsonb),
           'metadata', jsonb_build_object(
             'effective_from',      COALESCE(activated_at, created_at),
             'created_by',          proposed_by,
             'previous_version_id', NULL,
             'migrated_from_legacy', true
           ),
           -- Embedded mirror: lets the renderer reach the legacy payload
           -- via the Drizzle-shaped row (which only carries profile_body).
           'legacy_mirror', jsonb_build_object(
             'core_immutable',      core_immutable,
             'operational_profile', operational_profile,
             'episodic_temp',       episodic_temp,
             'growth_backlog',      growth_backlog
           )
         )
       WHERE profile_body = '{}'::jsonb
    $sql$;
  END IF;

  EXECUTE 'CREATE TRIGGER agent_op_profile_content_immutable_trg
             BEFORE UPDATE ON agent_operational_profile_versions
             FOR EACH ROW
             EXECUTE FUNCTION agent_op_profile_content_immutable()';
END;
$$;
