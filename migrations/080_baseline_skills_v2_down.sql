-- Down migration for 080_baseline_skills_v2.sql (issue #448)
--
-- Removes ONLY the rows this migration created:
--   - version=2 rows for the 5 converted baseline skills
--     (safe_conversation, retrieve_context, handoff_to_owner,
--      remember_safe_fact, audit_decision)
--   - version=1 rows for the 3 new baseline skills
--     (escalate_on_risk, summarization, manage_conversation_state)
--
-- The v1 prompt_only rows seeded by migration 075 are NOT touched.
-- Scoped tightly (tenant + agent_id IS NULL + proposed_by='system' +
-- descriptor + version) so it never touches operator-created or
-- agent-proposed skills that happen to share a descriptor at a
-- different version/agent/tenant.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. Always back up first.

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
