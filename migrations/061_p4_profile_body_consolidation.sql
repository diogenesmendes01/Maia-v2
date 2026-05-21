-- P4 (v3.1.1 alignment): add `profile_body` JSONB alongside the four legacy
-- columns. This migration is intentionally ADDITIVE — it does NOT drop
-- `core_immutable`, `operational_profile`, `episodic_temp`, or
-- `growth_backlog`, because the runtime renderer (`renderOperationalProfile`)
-- still reads those legacy columns directly from the row.
--
-- Why this migration exists:
--   * Migration 025 created the table with four legacy JSONB columns
--     reflecting the original P4 design.
--   * The v3.1.1-2026-05-15 refactor introduced a consolidated `profile_body`
--     column in `schema.ts` and `operationalProfileVersionsRepo.create`, but
--     no SQL migration was ever shipped, so a fresh `npm run db:migrate`
--     left the table without the new column. Any new INSERT then errored
--     with `column "profile_body" does not exist`. Surfaced while
--     smoke-testing the admin-ui agent-setup flow (PR #163).
--
-- Why ADDITIVE (Codex review of PR #163, [high]):
--   The first draft of this migration dropped the legacy columns and
--   backfilled `profile_body.identity = core_immutable`. That mapping does
--   NOT produce the canonical ProfileBody shape (identity.role_descriptor,
--   identity.voice, identity.cognitive_limits, identity.priorities), and
--   `renderOperationalProfile` still reads the legacy columns by name. Any
--   legacy active profile would render as a near-empty prompt after the
--   migration. Keeping the legacy columns preserves the runtime contract
--   while letting new code write to `profile_body`. A follow-up migration
--   can drop the legacy columns once the renderer is updated to read from
--   `profile_body` (or once those rows are re-written by the proposal
--   pipeline).
--
-- Trigger handling: `agent_op_profile_content_immutable_trg` (created in
-- migration 027) compares `NEW.profile_body` against `OLD.profile_body`.
-- That works once the column exists; until 061 has run, the trigger was
-- effectively dormant on legacy DBs because `agent_operational_profile_versions`
-- is append-only (no UPDATE path triggers it). After 061 the column is
-- present so the immutability guard becomes functional.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE agent_operational_profile_versions
  ADD COLUMN IF NOT EXISTS profile_body JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Best-effort backfill: synthesize a partial ProfileBody from legacy data so
-- callers that ONLY read `profile_body` (e.g. the new admin-ui flow) have
-- at least the identity bits populated. The renderer keeps reading legacy
-- columns; this backfill is a parallel snapshot, not a replacement.
--
-- Mapping (best effort — legacy shape is not the canonical ProfileBody shape):
--   identity.role_descriptor  ← core_immutable.identity_block      (string)
--   identity.priorities       ← core_immutable.principles          (array)
--   identity.voice.tone       ← operational_profile.voice_descriptor (string)
--   style                     ← {} (no legacy equivalent)
--   metadata                  ← { effective_from: created_at, created_by: proposed_by }
--
-- Rows where the legacy columns don't exist (already-migrated DBs) end up
-- with an empty `profile_body` from the column default — that's fine because
-- the trigger is disabled during the UPDATE.
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

  IF NOT has_legacy THEN
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

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
         )
       )
     WHERE profile_body = '{}'::jsonb
  $sql$;

  EXECUTE 'CREATE TRIGGER agent_op_profile_content_immutable_trg
             BEFORE UPDATE ON agent_operational_profile_versions
             FOR EACH ROW
             EXECUTE FUNCTION agent_op_profile_content_immutable()';
END;
$$;
