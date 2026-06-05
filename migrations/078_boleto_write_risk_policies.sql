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
-- rule_body uses the canonical P9b DSL shape `PolicyRuleBody`
-- ({rule_id, predicate, effect}) from src/governance/policy-dsl/types.ts, so the
-- rows are parseable + validatable by `validatePolicyRuleBody` and the evaluator:
--   - predicate is a kind-tagged boolean tree (kind: 'leaf' | 'and' | 'or');
--   - predicates reference ONLY fields the Mid PEP fact actually provides
--     (`src/runtime/decision/mid-pep.ts`): the three writes via membership in
--     `skill.selected.allowed_tools`, and risk via `risk.level`. This avoids the
--     silent-allow trap — a predicate on a MISSING field yields `not_applicable`,
--     which the adapter maps to ALLOW (`prod-env.ts`). A confirm/risk policy keyed
--     on a non-existent field (`tool_call.name`, `risk_profile.level`,
--     `legal_intent.*`, ...) would silently permit everything once evaluation is
--     wired. Richer signals (legal intent, receipt suspicion, formal dispute, ...)
--     are listed under `effect.metadata.intended_signals_pending_437` and will be
--     folded into the risk profile / context by #437.
--   - effect.action is from the DSL vocabulary (allow | block |
--     require_dual_approval | warn | log). "confirm before write" and "escalate
--     to human" both map to `require_dual_approval`; finer intent is in metadata.intent.
--
-- IMPORTANT — RUNTIME EVALUATION IS A FOLLOW-UP, NOT THIS ISSUE: the descriptor
-- resolver (policy-descriptor-resolver.ts) does NOT yet evaluate this DSL for
-- these descriptors, and constitutionalCheck does not yet branch on the three
-- boleto writes. Today the rows are well-formed but DECLARATIVE — the writes are
-- still gated by the grant guard + canAct + constitutionalCheck (compose, don't
-- bypass), but the confirm/escalate DECISION is not enforced until the runtime
-- wiring lands (tracked as a follow-up). The seed is DSL-correct now so that
-- wiring needs no data migration.
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
    '{"rule_id":"confirm_before_write_policy","predicate":{"kind":"or","predicates":[{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"boleto_cancel"},{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"company_campaign_remove"},{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"refund_create"}]},"effect":{"action":"require_dual_approval","message":"Operação sensível: requer empresa identificada e confirmação explícita antes de executar; bloqueia se a identidade estiver ambígua ou se a política de risco exigir escalação.","metadata":{"severity":"high","intent":"confirm_before_write","governed_tools":["boleto_cancel","company_campaign_remove","refund_create"],"requires":{"company_identified":true,"user_confirmation":true,"audit_before_and_after":true},"intended_signals_pending_437":["company_identity.ambiguous","risk_requires_escalation"],"applies_to_peps":["mid","late"]}}}',
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
    '{"rule_id":"small_risk_write_policy","predicate":{"kind":"and","predicates":[{"kind":"or","predicates":[{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"boleto_cancel"},{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"company_campaign_remove"},{"kind":"leaf","field":"skill.selected.allowed_tools","op":"contains","value":"refund_create"}]},{"kind":"leaf","field":"risk.level","op":"eq","value":"low"}]},"effect":{"action":"allow","message":"Variante futura: pode permitir escrita automática em casos de baixo risco. NÃO habilitada por padrão em #416.","metadata":{"severity":"low","intent":"small_risk_auto_write","intended_signals_pending_437":["company_identity.confidence=high","action.reversible","legal_intent.detected=false","payment_data.consistent","audience.allows_execution"],"applies_to_peps":["mid","late"]}}}',
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
    '{"rule_id":"human_confirmation_policy","predicate":{"kind":"leaf","field":"risk.level","op":"in","value":["medium","high","critical"]},"effect":{"action":"require_dual_approval","message":"Caso requer confirmação/handoff humano antes de prosseguir (risco médio/alto, ameaça jurídica, reclamação formal, identidade ambígua, comprovante suspeito, valor acima do limite ou disputa formal).","metadata":{"severity":"high","intent":"escalate_to_human","intended_signals_pending_437":["legal_intent.detected","case.formal_complaint","company_identity.ambiguous","receipt.suspicious","case.value_over_threshold","case.formal_dispute"],"applies_to_peps":["early","mid","late"]}}}',
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
