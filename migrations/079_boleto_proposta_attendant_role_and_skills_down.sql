-- Down migration for 079_boleto_proposta_attendant_role_and_skills.sql (issue #415)
--
-- WARNING: destructive. Removes the seeded role + its 8 role-specific skills and
-- drops the two capability-taxonomy axis columns added by the forward migration.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain only);
-- they are applied manually via `psql -f` per docs/runbooks/migrations.md. Always
-- back up first.
--
-- ORDER: delete the seeded ROWS before dropping the columns they populated, so
-- the deletes can still reference the seeded data shape. Reverses the forward
-- migration exactly.

-- 1. Remove the 8 seeded role-specific skills (tenant-wide, system seed, v1).
DELETE FROM skills
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND version = 1
  AND proposed_by = 'system'
  AND skill_descriptor IN (
    'identify_company_customer',
    'inspect_customer_billing_context',
    'cancel_proposal_billing',
    'refund_intake',
    'refund_followup',
    'analyze_customer_documents',
    'answer_boleto_proposal_questions',
    'evaluate_escalation_need'
  );

-- 2. Remove the seeded role.
DELETE FROM roles
WHERE tenant_id = 'default'
  AND agent_id = 'default'
  AND role_key = 'whatsapp_boleto_proposta_attendant';

-- 3. Drop the role → skill and role → tool-pack axis columns.
--    NOTE: this reverts the axes platform-wide; only run on a full rollback of
--    #415 (no other migration depends on these columns at the time of writing).
ALTER TABLE skills DROP COLUMN IF EXISTS applicable_to_role;
ALTER TABLE roles DROP COLUMN IF EXISTS granted_packs;
