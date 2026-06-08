-- Down migration for 080_baseline_skills_v2.sql (issue #448)
--
-- Reverses the forward migration in safe order:
--
-- Step 2 reversal (FIRST): delete the v2/new v1 tool_mediated rows so
--   the one-active invariant (idx_skills_one_active_uq) is cleared
--   before re-activating the v1 rows. Scoped tightly (tenant +
--   agent_id IS NULL + proposed_by='system' + descriptor + version) so
--   it never touches operator-created or agent-proposed rows.
--
-- Step 1 reversal (SECOND): re-activate the v1 prompt_only rows that
--   were deprecated by the forward migration (status='active', clear
--   deprecated_at). Safe because the conflicting v2 active rows were
--   deleted in the step above. Idempotent: the version=1 AND
--   status='deprecated' guard prevents re-activating unrelated rows.
--
-- Step 3 reversal: no explicit reversal needed for usage_policy. The
--   policy is permissive; after Step 2 deletes the rows there is nothing
--   to revert. The re-activated v1 rows already have their original
--   usage_policy from migration 077.
--
-- NOTE: The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. Always back up first.

-- Step 2 reversal: delete v2 and new v1 rows FIRST so the one-active
-- invariant (idx_skills_one_active_uq) does not block the re-activation
-- of v1 rows in the next step.
DELETE FROM skills
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND proposed_by = 'system'
  AND (
    (skill_descriptor IN (
       'safe_conversation',
       'retrieve_context',
       'handoff_to_owner',
       'remember_safe_fact',
       'audit_decision'
     ) AND version = 2)
    OR
    (skill_descriptor IN (
       'escalate_on_risk',
       'summarization',
       'manage_conversation_state'
     ) AND version = 1)
  );

-- Step 1 reversal: re-activate the v1 prompt_only rows (now safe since
-- the v2 active rows were deleted above).
UPDATE skills
SET
  status = 'active',
  deprecated_at = NULL
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND proposed_by = 'system'
  AND status = 'deprecated'
  AND skill_descriptor IN (
    'safe_conversation',
    'retrieve_context',
    'handoff_to_owner',
    'remember_safe_fact',
    'audit_decision'
  )
  AND version = 1;
