-- P8e: Seed das 5 hard_limit/lockdown_trigger policies para tenant='default'.
-- Idempotente (NOT EXISTS por descriptor); 'active' direto no seed é exceção
-- controlada — válida APENAS para bootstrap. Runtime Admin UI (P8.5) sempre
-- segue dual-approval workflow.
-- Sources: spec §7.3.1-7.3.5 (master spec v3.1.1).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

INSERT INTO policy_rules (
  tenant_id, agent_id, rule_kind, rule_descriptor, rule_body, scope,
  source_of_truth, status, version, proposed_by, proposed_reason,
  approved_by, approved_at, activated_at
)
SELECT
  'default', NULL, v.rule_kind, v.rule_descriptor, v.rule_body::jsonb,
  v.scope::jsonb, v.source_of_truth, 'active', 1, 'p8e_seed', v.proposed_reason,
  'p8e_seed', NOW(), NOW()
FROM (VALUES
  -- 7.3.1 no_refund_without_validation (hard_limit, founder_explicit)
  (
    'hard_limit',
    'no_refund_without_validation',
    '{"predicate":{"all":[{"field":"intent.label","op":"eq","value":"refund"},{"field":"context.validation_status","op":"neq","value":"validated"}]},"effect":{"action":"block","severity":"high","message_template":"Reembolso requer validação prévia. Solicite confirmação do supervisor."},"applies_to_peps":["mid","late"]}',
    '{}',
    'founder_explicit',
    'Founder rule: nunca processar refund sem validação humana'
  ),
  -- 7.3.2 lgpd_strict_no_pii_in_logs (hard_limit, legal_compliance)
  (
    'hard_limit',
    'lgpd_strict_no_pii_in_logs',
    '{"predicate":{"any":[{"field":"output.contains_pii","op":"eq","value":true},{"field":"tool_call.audit_level","op":"eq","value":"full_payload"}]},"effect":{"action":"block","severity":"critical","message_template":"LGPD: dados pessoais nao podem aparecer em logs/audit completo. Redacted obrigatorio."},"applies_to_peps":["late"]}',
    '{}',
    'legal_compliance',
    'LGPD Art. 7 + 11 — base legal de tratamento exige minimizacao'
  ),
  -- 7.3.3 no_action_outside_business_hours_high_risk (hard_limit, founder_explicit, scope=whatsapp)
  (
    'hard_limit',
    'no_action_outside_business_hours_high_risk',
    '{"predicate":{"all":[{"field":"risk_profile.level","op":"in","value":["high","critical"]},{"field":"context.is_business_hours","op":"eq","value":false}]},"effect":{"action":"escalate","severity":"high","message_template":"Acao de risco alto fora do horario comercial — escalar humano antes de executar."},"applies_to_peps":["early","mid"]}',
    '{"channel":"whatsapp"}',
    'founder_explicit',
    'Founder rule: zero acao irreversivel fora de horario, em alto risco'
  ),
  -- 7.3.4 tenant_lockdown_blocks_all_writes (lockdown_trigger, founder_explicit)
  (
    'lockdown_trigger',
    'tenant_lockdown_blocks_all_writes',
    '{"predicate":{"all":[{"field":"tenant.lockdown_active","op":"eq","value":true},{"field":"tool_call.side_effect_level","op":"in","value":["medium","high"]}]},"effect":{"action":"block","severity":"critical","message_template":"Tenant em lockdown — escritas bloqueadas. Contate suporte."},"applies_to_peps":["early"]}',
    '{}',
    'founder_explicit',
    'Kill switch global por tenant — invariante de seguranca'
  ),
  -- 7.3.5 no_financial_advice_without_compliance_disclaimer (hard_limit, legal_compliance)
  (
    'hard_limit',
    'no_financial_advice_without_compliance_disclaimer',
    '{"predicate":{"all":[{"field":"intent.label","op":"in","value":["investment_advice","tax_advice"]},{"field":"output.contains_disclaimer","op":"eq","value":false}]},"effect":{"action":"warn_in_trace","severity":"medium","message_template":"Conselho financeiro requer disclaimer compliance. Anexar template antes de enviar."},"applies_to_peps":["late"]}',
    '{}',
    'legal_compliance',
    'Compliance — orientacao financeira sem disclaimer fere CVM/BACEN regs'
  )
) AS v(rule_kind, rule_descriptor, rule_body, scope, source_of_truth, proposed_reason)
WHERE NOT EXISTS (
  SELECT 1 FROM policy_rules pr
  WHERE pr.tenant_id = 'default'
    AND pr.rule_descriptor = v.rule_descriptor
);
