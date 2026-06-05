-- Issue #416 — boleto proposal vertical: write/risk policy descriptors.
--
-- Seeds THREE policy_rules rows (tenant='default') that govern the sensitive
-- write tools of the boleto-proposta vertical WITHOUT embedding confirmation
-- inside skills (capability-taxonomy §3/§6: "a skill never decides confirmation
-- or write authorization — policy + the dispatcher decide execution"):
--
--   1. confirm_before_write_policy — DEFAULT for the three sensitive writes
--      (boleto_cancel, company_campaign_remove, refund_create). Requires
--      identified company context + explicit user confirmation + audit
--      before/after; blocks on ambiguous identity; escalates when the risk
--      policy says so. dual_approval (hard_limit kind) so activation is the
--      strictest governance path (mirrors 037).
--   2. small_risk_write_policy — a FUTURE variant that MAY allow automatic
--      low-risk write execution. Seeded as `proposed` (NOT active) — issue #416
--      explicitly does NOT enable automatic low-risk writes by default; the
--      descriptor exists only so the policy model carries the variant instead of
--      hardcoding confirmation in skills. soft_guidance kind.
--   3. human_confirmation_policy — variant for cases needing human confirmation/
--      handoff (medium/high risk, legal threat, formal complaint, ambiguous
--      identity, suspicious receipt, value above threshold, formal dispute).
--      dual_approval kind.
--
-- rule_body is OPAQUE JSONB here (the DB CHECK in 036 only enforces
-- jsonb_typeof='object'); the shape mirrors the 037 hard-limit seed
-- ({predicate, effect, applies_to_peps}) so the descriptor resolver
-- (src/control-plane/policy/policy-descriptor-resolver.ts) and the existing
-- governance machinery treat these like any other policy_rules row. The write
-- tools still pass constitutionalCheck + the dispatcher guard regardless (the
-- "compose, don't bypass" rule) — these descriptors add the confirm/escalate
-- decision on top, they do NOT open a parallel write path.
--
-- Idempotent (NOT EXISTS per descriptor). 'active' direct in the seed for
-- confirm_before_write_policy + human_confirmation_policy is the controlled
-- bootstrap exception (same posture as 037); runtime changes go through the
-- Admin UI dual-approval workflow.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps the file in a transaction.

INSERT INTO policy_rules (
  tenant_id, agent_id, rule_kind, rule_descriptor, rule_body, scope,
  source_of_truth, status, version, proposed_by, proposed_reason,
  approved_by, approved_at, activated_at
)
SELECT
  'default', NULL, v.rule_kind, v.rule_descriptor, v.rule_body::jsonb,
  v.scope::jsonb, v.source_of_truth, v.status, 1, 'issue_416_seed',
  v.proposed_reason,
  -- Only the two ACTIVE bootstrap rules carry approver columns; the proposed
  -- small_risk_write_policy variant is left unapproved (NULLs) so it cannot be
  -- mistaken for an enabled auto-write path.
  CASE WHEN v.status = 'active' THEN 'issue_416_seed' ELSE NULL END,
  CASE WHEN v.status = 'active' THEN NOW() ELSE NULL END,
  CASE WHEN v.status = 'active' THEN NOW() ELSE NULL END
FROM (VALUES
  -- 1. confirm_before_write_policy (ACTIVE, dual_approval) — governs the three
  --    sensitive writes. Matches any tool whose side-effect is a write among the
  --    three governed tools; effect = require explicit confirmation before exec.
  (
    'dual_approval',
    'confirm_before_write_policy',
    '{"predicate":{"all":[{"field":"tool_call.side_effect_level","op":"eq","value":"write"},{"field":"tool_call.name","op":"in","value":["boleto_cancel","company_campaign_remove","refund_create"]}]},"effect":{"action":"require_confirmation","severity":"high","message_template":"Operação sensível: requer empresa identificada e confirmação explícita do usuário antes de executar. Bloqueia se a identidade estiver ambígua ou se a política de risco exigir escalação."},"requires":{"company_identified":true,"user_confirmation":true,"audit_before_and_after":true},"blocks_when":{"identity_ambiguous":true,"risk_requires_escalation":true},"applies_to_peps":["mid","late"]}',
    '{}',
    'founder_explicit',
    'active',
    'Issue #416: escritas sensíveis (boleto_cancel, company_campaign_remove, refund_create) exigem confirmação explícita — nunca decidida pela skill.'
  ),
  -- 2. small_risk_write_policy (PROPOSED, soft_guidance) — future auto-write
  --    variant. NOT active: #416 does not enable automatic low-risk writes.
  (
    'soft_guidance',
    'small_risk_write_policy',
    '{"predicate":{"all":[{"field":"tool_call.side_effect_level","op":"eq","value":"write"},{"field":"company_identity.confidence","op":"eq","value":"high"},{"field":"risk_profile.level","op":"eq","value":"low"},{"field":"action.reversible","op":"eq","value":true},{"field":"legal_intent.detected","op":"eq","value":false},{"field":"payment_data.consistent","op":"eq","value":true},{"field":"audience.allows_execution","op":"eq","value":true}]},"effect":{"action":"allow","severity":"low","message_template":"Variante futura: pode permitir escrita automática em casos de baixo risco. NÃO habilitada por padrão em #416."},"applies_to_peps":["mid","late"]}',
    '{}',
    'founder_explicit',
    'proposed',
    'Issue #416: variante FUTURA para escrita automática de baixo risco. Mantida como proposed para que o modelo de policy carregue a variante sem hardcode de confirmação na skill.'
  ),
  -- 3. human_confirmation_policy (ACTIVE, dual_approval) — escalate/handoff for
  --    risky cases (medium/high risk, legal threat, complaint, ambiguous
  --    identity, suspicious receipt, value over threshold, formal dispute).
  (
    'dual_approval',
    'human_confirmation_policy',
    '{"predicate":{"any":[{"field":"risk_profile.level","op":"in","value":["medium","high"]},{"field":"legal_intent.detected","op":"eq","value":true},{"field":"case.formal_complaint","op":"eq","value":true},{"field":"company_identity.ambiguous","op":"eq","value":true},{"field":"receipt.suspicious","op":"eq","value":true},{"field":"case.value_over_threshold","op":"eq","value":true},{"field":"case.formal_dispute","op":"eq","value":true}]},"effect":{"action":"escalate","severity":"high","message_template":"Caso requer confirmação/handoff humano antes de prosseguir (risco médio/alto, ameaça jurídica, reclamação formal, identidade ambígua, comprovante suspeito, valor acima do limite ou disputa formal)."},"applies_to_peps":["early","mid","late"]}',
    '{}',
    'founder_explicit',
    'active',
    'Issue #416: casos de risco/jurídico/disputa exigem confirmação ou handoff humano — escala antes de executar a escrita.'
  )
) AS v(rule_kind, rule_descriptor, rule_body, scope, source_of_truth, status, proposed_reason)
WHERE NOT EXISTS (
  SELECT 1 FROM policy_rules pr
  WHERE pr.tenant_id = 'default'
    AND pr.rule_descriptor = v.rule_descriptor
);
