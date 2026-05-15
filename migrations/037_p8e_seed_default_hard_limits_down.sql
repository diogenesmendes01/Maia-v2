-- Down of 037: delete seed rows by descriptor. Safe (idempotent).
DELETE FROM policy_rules
WHERE tenant_id = 'default'
  AND rule_descriptor IN (
    'no_refund_without_validation',
    'lgpd_strict_no_pii_in_logs',
    'no_action_outside_business_hours_high_risk',
    'tenant_lockdown_blocks_all_writes',
    'no_financial_advice_without_compliance_disclaimer'
  );
