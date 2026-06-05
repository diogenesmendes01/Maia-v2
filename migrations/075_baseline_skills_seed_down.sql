-- Down migration for 075_baseline_skills_seed.sql (issue #410)
--
-- Removes ONLY the system-seeded baseline skills: tenant 'default',
-- tenant-wide (agent_id IS NULL), version=1, proposed_by='system', and one of
-- the 8 known baseline descriptors. Scoped tightly (matching the seed's own
-- predicates) so it never touches operator-created or agent-proposed skills
-- that happen to share a descriptor at a different version/agent/tenant.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain only);
-- they are applied manually via `psql -f` per docs/runbooks/migrations.md.

DELETE FROM skills
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND version = 1
  AND proposed_by = 'system'
  AND skill_descriptor IN (
    'safe_conversation',
    'ask_clarification',
    'request_confirmation',
    'handoff_to_owner',
    'remember_safe_fact',
    'retrieve_context',
    'explain_limitation',
    'audit_decision'
  );
