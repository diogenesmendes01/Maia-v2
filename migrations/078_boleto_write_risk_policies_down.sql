-- Down migration for 078_boleto_write_risk_policies.sql
-- WARNING: destructive — review before applying. Run in transaction.
--
-- Deletes ONLY the bootstrap rows created by the issue #416 seed. Constrained to
-- version=1, agent_id IS NULL, and proposed_by='issue_416_seed' so operator-
-- created versions (v2, v3, …) or human-proposed rows for the same descriptors
-- are NOT removed on rollback (same posture as 037's down).
BEGIN;

DELETE FROM policy_rules
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND version = 1
  AND proposed_by = 'issue_416_seed'
  -- Match the seed's approver too (037 posture): the two ACTIVE rows were
  -- approved by 'issue_416_seed'; the PROPOSED variant has no approver (NULL).
  -- A row later re-approved by a human (different approved_by) is NOT removed.
  AND (approved_by = 'issue_416_seed' OR approved_by IS NULL)
  AND rule_descriptor IN (
    'confirm_before_write_policy',
    'small_risk_write_policy',
    'human_confirmation_policy'
  );

COMMIT;
