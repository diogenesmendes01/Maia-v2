-- Down of 037: delete ONLY the bootstrap rows created by the p8e_seed script.
-- Constrained to version=1, agent_id IS NULL, and both proposed_by/approved_by
-- set to 'p8e_seed' so that operator-created versions (v2, v3, …) or rows
-- proposed by humans for the same descriptors are NOT removed on rollback.
DELETE FROM policy_rules
WHERE tenant_id = 'default'
  AND agent_id IS NULL
  AND version = 1
  AND proposed_by = 'p8e_seed'
  AND approved_by = 'p8e_seed'
  AND rule_descriptor IN (
    'no_refund_without_validation',
    'lgpd_strict_no_pii_in_logs',
    'no_action_outside_business_hours_high_risk',
    'tenant_lockdown_blocks_all_writes',
    'no_financial_advice_without_compliance_disclaimer'
  );
