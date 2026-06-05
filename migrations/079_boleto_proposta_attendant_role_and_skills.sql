-- =====================================================================
-- Maia — Migration 079 (issue #415)
-- WhatsApp "Atendente de Boleto Proposta" RUNTIME ROLE + its role-specific
-- SKILLS, modeled as INCREMENTAL over the universal agent baseline.
--
-- Canonical spec: docs/architecture/concerns/capability-taxonomy.md
--   §2 (effective-turn composition: baseline + channel + ROLE + role skill
--       grants + role tool packs + policies), §3 (who decides what — a skill
--       declares intent+scope, policy + dispatcher decide execution), §4
--       (baseline is universal; a role lists only what it ADDS), §5 (role→skill
--       `applicable_to_role` and role→tool-pack are NEW axes), §7 (anti-patterns:
--       no confirmation/write/approval rule inside a skill or role).
--
-- WHAT THIS MIGRATION DOES
--   1. Adds the two NEW capability-taxonomy axes as columns (idempotent):
--        - roles.granted_packs          (role → tool-pack, mirrors agent_tool_grants.granted_packs)
--        - skills.applicable_to_role     (role → skill, mirrors allowed_tools/policy_descriptors)
--      Both default to '{}' so EVERY existing role/skill is unchanged (a role
--      grants no extra pack by default; a skill applies to any role by default).
--   2. Seeds the role `whatsapp_boleto_proposta_attendant` (display name,
--      responsibility, operational objectives in metadata, prompt_addendum,
--      and granted_packs = the 6 boleto tool packs defined by #416).
--   3. Seeds the 8 role-specific skills (TENANT-WIDE, status='active',
--      proposed_by/approved_by='system', version=1), each scoped to the role via
--      applicable_to_role. They do NOT re-declare baseline skills
--      (safe_conversation / request_confirmation / handoff_to_owner / …).
--
-- OUT OF SCOPE (companion issue #416): tool implementations, tool-pack
--   definitions, write/risk policy implementations, dispatcher guards. The pack
--   ids, tool names, and policy descriptors below are referenced BY STRING and
--   may not resolve to real rows until #416 lands — that is expected.
--
-- GOVERNANCE (invariant #6 — identity is governed; skills/roles are never "born
--   active" by the AGENT): these rows are a GOVERNED, AUDITABLE SYSTEM seed
--   (proposed_by/approved_by='system'), exactly like the baseline-skills seed
--   (migration 075) and the default-role seed (migration 035). The skill
--   selector reads `agent_id IS NULL OR agent_id = $agent`, so the tenant-wide
--   skills are visible to every agent in the tenant; `applicable_to_role` then
--   scopes them to turns where this role is active.
--
-- TENANT ISOLATION (invariant #1): seeded under the bootstrap tenant 'default'
--   (same as 035/075). Multi-tenant rollout seeds per tenant via the same
--   idempotent INSERTs; nothing here is cross-tenant.
--
-- SKILLS DO NOT HARDCODE EXECUTION (invariant #2 / taxonomy §3, §6/§7): the two
--   write skills (`cancel_proposal_billing`, `refund_intake`) declare INTENT +
--   SCOPE and reference policy descriptors (confirm_before_write_policy /
--   small_risk_write_policy / human_confirmation_policy). Whether a write runs,
--   asks for confirmation, blocks, or escalates is decided by policy + the
--   dispatcher guard — NEVER by a skill body. Company identification resolves
--   informal identity (`company_identity_resolver`) BEFORE formal lookup
--   (`company_search`); "no write while identity is ambiguous" is expressed as
--   skill behaviour + deferred to policy, not as a hardcoded guard.
--
-- IDEMPOTENT: column adds use IF NOT EXISTS; the role INSERT uses
--   ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING; the skills INSERT
--   uses ON CONFLICT on the version-unique index DO NOTHING. Re-runs are safe and
--   never overwrite an operator-edited row.
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration in a
--   transaction (no `-- maia:no-transaction` marker here). Mirrors 075/076.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. NEW capability-taxonomy axes (idempotent, additive, default '{}').
-- ---------------------------------------------------------------------

-- role → tool-pack (taxonomy §5). Pack ids (strings) from src/tools/packs.ts
-- (#408/#416). baseline.core is unioned at runtime, so a role lists only what it
-- ADDS. Default '{}' leaves every existing role granting no extra pack.
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS granted_packs TEXT[] NOT NULL DEFAULT '{}'::text[];

-- role → skill (taxonomy §5). Role keys for which a skill is in scope. EMPTY =
-- applies regardless of active role (baseline behaviour). The SkillSelector
-- keeps a candidate only when its non-empty applicable_to_role contains the
-- turn's active role (selector(intent) ∩ applicable_to_role). Default '{}'
-- leaves every existing skill universal.
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS applicable_to_role TEXT[] NOT NULL DEFAULT '{}'::text[];

-- ---------------------------------------------------------------------
-- 2. Seed the role.
-- ---------------------------------------------------------------------
-- granted_packs = the 6 boleto tool packs (#416 defines them; referenced by
-- string). responsibility + operational objectives live in metadata so they are
-- available to Admin UI / runtime configuration. prompt_addendum is the only
-- behavioural injection a role carries (taxonomy §3 — a role adds prompt context
-- + grants, nothing executable).
INSERT INTO roles (
  tenant_id, agent_id, role_key, display_name, description,
  prompt_addendum, granted_packs, active, is_default, metadata
)
VALUES (
  'default', 'default',
  'whatsapp_boleto_proposta_attendant',
  'Atendente de Boleto Proposta - WhatsApp',
  'Atende empresas via WhatsApp sobre boleto proposta, DDA, cobrança, baixa, cancelamento, reembolso e dúvidas operacionais. Resolve casos de baixa e média complexidade sem intervenção humana quando a policy permitir; escala casos jurídicos, financeiramente sensíveis ou fora de fluxo.',
  -- prompt_addendum: behavioural context only (no executable logic, no
  -- confirmation/write rules — those are policy, taxonomy §7).
  E'Você atende EMPRESAS via WhatsApp no contexto de boleto proposta (proposta de cobrança), DDA, baixa, cancelamento e reembolso.\n\nDiretrizes operacionais:\n- Resolva o caso no primeiro contato sempre que possível.\n- Identifique a empresa corretamente ANTES de qualquer ação operacional; comece pela identidade informal (apelido, nome do sócio, "sou da Suzuki") e só depois faça a busca formal. Não execute ações de escrita enquanto a identidade estiver ambígua.\n- Explique de forma clara e cordial os processos de boleto proposta, DDA, pagamento, campanha, cancelamento e reembolso.\n- Execute apenas ações operacionais autorizadas; quem decide confirmação, execução, bloqueio ou escalonamento é a policy — você apenas declara a intenção e o contexto.\n- Proteja a operação de risco jurídico, financeiro, reputacional e de privacidade; ao detectar sinal jurídico ou caso fora do fluxo, escale.\n- Mantenha o tom curto, claro e adequado ao WhatsApp.\n\nCapacidades universais (conversa segura, pedir confirmação, respeitar privacidade, auditar, explicar limitação, hand-off ao dono, escalar em risco, recuperar contexto) vêm do baseline e do canal — este papel apenas ACRESCENTA as habilidades e os pacotes de ferramentas do domínio boleto proposta.',
  -- 6 boleto tool packs (#416). Referenced by string; may not resolve until #416 lands.
  ARRAY[
    'boleto_proposal_read_pack',
    'boleto_proposal_write_pack',
    'refund_intake_pack',
    'refund_followup_pack',
    'document_analysis_pack',
    'risk_escalation_pack'
  ]::text[],
  true,   -- active
  false,  -- is_default (this is a specialized role, never the default)
  jsonb_build_object(
    'issue', 415,
    'taxonomy_doc', 'docs/architecture/concerns/capability-taxonomy.md',
    'incremental_over_baseline', true,
    'responsibility', 'Handle companies over WhatsApp about boleto proposta, DDA, cobrança, baixa, cancelamento, reembolso, and operational questions. Resolve low/medium complexity cases without human intervention when allowed by policy; escalate legal, financially-sensitive, or out-of-flow cases.',
    'operational_objectives', jsonb_build_array(
      'Resolve the case on first contact whenever possible.',
      'Identify the company correctly before operational actions.',
      'Explain boleto proposal, DDA, payment, campaign, cancellation, and refund processes clearly.',
      'Execute only authorized operational actions.',
      'Protect the operation from legal, financial, reputational, and privacy risk.',
      'Keep relevant actions auditable.'
    ),
    'baseline_assumptions', jsonb_build_array(
      'safe_conversation', 'request_confirmation', 'respect_privacy',
      'audit_decision', 'explain_limitation', 'handoff_to_owner',
      'escalate_on_risk', 'retrieve_context', 'manage_conversation_state',
      'summarization', 'whatsapp_channel_behavior'
    ),
    'role_specific_skills', jsonb_build_array(
      'identify_company_customer', 'inspect_customer_billing_context',
      'cancel_proposal_billing', 'refund_intake', 'refund_followup',
      'analyze_customer_documents', 'answer_boleto_proposal_questions',
      'evaluate_escalation_need'
    )
  )
)
ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Seed the 8 role-specific skills.
-- ---------------------------------------------------------------------
-- Tenant-wide (agent_id NULL), active, system-governed, version 1, scoped to the
-- role via applicable_to_role. allowed_tools reference the tool names #416 adds;
-- policy_descriptors (write skills only) reference the #416 policy descriptors.
-- procedure/input_schema/output_schema are minimal placeholders (this issue
-- defines the CONTRACT — the executable procedure body is not in scope here).
INSERT INTO skills (
  tenant_id, agent_id, skill_descriptor, category, execution_mode,
  goal, when_to_use, procedure, constraints,
  input_schema, output_schema,
  allowed_tools, policy_descriptors, applicable_to_role, usage_policy,
  success_criteria, failure_modes, runtime_hints,
  status, version, proposed_by, proposed_reason,
  approved_by, approved_at, activated_at
)
SELECT
  'default', NULL, v.skill_descriptor, v.category, v.execution_mode,
  v.goal, v.when_to_use, '{}'::jsonb, '[]'::jsonb,
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  v.allowed_tools::text[], v.policy_descriptors::text[],
  ARRAY['whatsapp_boleto_proposta_attendant']::text[],
  -- usage_policy (#409): EXPLICIT per-skill admission so the EXTERNAL WhatsApp
  -- audience (company customers / leads) is ADMITTED. Without it the skills fall
  -- to the conservative NULL default (internal-only), which the #409 gate uses to
  -- block customer/lead — exactly this role's target audience. (The role→skill
  -- gate is now active: the decision engine threads `active_role_key` (#436), so
  -- role-bound skills are selected for the active role; this seed must therefore
  -- admit the intended external audience.) Profiles:
  --   A = own-customer data (company's OWN billing), subject_only; READS block at/
  --       above HIGH risk, the two WRITES (cancel_proposal_billing, refund_intake)
  --       block at/above MEDIUM risk — financial writes are stricter (review r2 #2).
  --       (Auth stays known_external: a customer acts on their OWN billing; the
  --       extra write authority is enforced by the write-policy gate, not by
  --       raising the skill's required trust above the target audience — #437.)
  --   B = public/process info (identification + Q&A; admits leads), public_safe;
  --   C = internal escalation (ticket/handoff): a customer/lead may TRIGGER the
  --       evaluation, but the risk/legal verdict is internal_only — never exposed
  --       to them; it feeds the human handoff/confirmation policy. internal_only is
  --       deliberate here (subject_only would leak the verdict) — review r2 #3.
  -- All require known_external trust and never self-confirm (confirmation is the
  -- write/risk policy's job, never the skill's).
  CASE v.skill_descriptor
    WHEN 'inspect_customer_billing_context' THEN '{"allowed_audience":["customer"],"data_scope":["own_customer_data_only"],"exposure_policy":"subject_only","requires_auth_level":"known_external","requires_confirmation":false,"blocked_when_risk_at_or_above":"high"}'
    WHEN 'cancel_proposal_billing' THEN '{"allowed_audience":["customer"],"data_scope":["own_customer_data_only"],"exposure_policy":"subject_only","requires_auth_level":"known_external","requires_confirmation":false,"blocked_when_risk_at_or_above":"medium"}'
    WHEN 'refund_intake' THEN '{"allowed_audience":["customer"],"data_scope":["own_customer_data_only"],"exposure_policy":"subject_only","requires_auth_level":"known_external","requires_confirmation":false,"blocked_when_risk_at_or_above":"medium"}'
    WHEN 'refund_followup' THEN '{"allowed_audience":["customer"],"data_scope":["own_customer_data_only"],"exposure_policy":"subject_only","requires_auth_level":"known_external","requires_confirmation":false,"blocked_when_risk_at_or_above":"high"}'
    WHEN 'analyze_customer_documents' THEN '{"allowed_audience":["customer"],"data_scope":["own_customer_data_only"],"exposure_policy":"subject_only","requires_auth_level":"known_external","requires_confirmation":false,"blocked_when_risk_at_or_above":"high"}'
    WHEN 'identify_company_customer' THEN '{"allowed_audience":["customer","lead"],"data_scope":["public_info"],"exposure_policy":"public_safe","requires_auth_level":"known_external","requires_confirmation":false}'
    WHEN 'answer_boleto_proposal_questions' THEN '{"allowed_audience":["customer","lead"],"data_scope":["public_info"],"exposure_policy":"public_safe","requires_auth_level":"known_external","requires_confirmation":false}'
    WHEN 'evaluate_escalation_need' THEN '{"allowed_audience":["customer","lead"],"data_scope":["own_customer_data_only","public_info"],"exposure_policy":"internal_only","requires_auth_level":"known_external","requires_confirmation":false}'
  END::jsonb,
  '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
  'active', 1, 'system', 'boleto proposta attendant role-specific skill (issue #415)',
  'system', NOW(), NOW()
FROM (VALUES
  -- 1. identify_company_customer — resolve informal identity BEFORE formal
  --    lookup; no write while identity is ambiguous (behaviour, not a guard).
  (
    'identify_company_customer', 'classify', 'tool_mediated',
    'Identificar a empresa que está em contato e estabelecer confiança suficiente para continuar o atendimento.',
    'Quando o cliente fornece CNPJ, razão social completa ou parcial, nome fantasia/apelido, nome de sócio/proprietário, ou se identifica de forma informal ("sou da Suzuki", "sou o Vanderlei"); ou quando o cliente ainda não está claramente identificado. Tente resolver a identidade informal antes da busca formal; peça um detalhe desambiguador quando houver múltiplas empresas; carregue histórico e blacklist só após resolver um candidato. Não permita ações de escrita enquanto a identidade estiver ambígua (decisão de policy).',
    '{company_identity_resolver,company_search,company_history_lookup,company_blacklist_check}',
    '{}'
  ),
  -- 2. inspect_customer_billing_context — read-oriented situational lookup.
  (
    'inspect_customer_billing_context', 'extract', 'tool_mediated',
    'Obter a situação de cobrança atual da empresa no sistema e explicá-la em linguagem adequada ao WhatsApp.',
    'Quando o cliente pergunta sobre um boleto, sobre o que é uma cobrança, diz que algo apareceu no DDA, quer saber se há registro em seu nome, ou pergunta sobre status de campanha/proposta. Busque boletos relacionados, cheque DDA quando relevante, verifique pagamento quando o cliente alega ter pago ou pergunta sobre status de pagamento, e cheque status de campanha quando perguntam por que receberam uma proposta.',
    '{boleto_search,dda_lookup,payment_verification,campaign_status_lookup,company_history_lookup}',
    '{}'
  ),
  -- 3. cancel_proposal_billing — WRITE-INTENT skill. Declares intent + scope,
  --    references write policies; execution decided by policy + dispatcher.
  (
    'cancel_proposal_billing', 'decide', 'tool_mediated',
    'Conduzir o fluxo operacional de cancelamento de boleto proposta e remoção de campanha quando o cliente solicita cancelamento, opt-out ou remoção da base. Declara intenção e escopo; a execução (automática, com confirmação, bloqueio ou escalonamento) é decidida pela policy e pelo dispatcher — esta skill NUNCA codifica regra de confirmação/autorização.',
    'Quando o cliente não tem interesse, pede para ser removido da base, solicita cancelamento de boleto, ou não quer mais receber propostas. Confirme a identidade da empresa antes de qualquer ação de escrita poder ser solicitada; explique o que será cancelado/removido; solicite a ferramenta de escrita apropriada só com o contexto necessário; reporte protocolo/status retornado; em caso ambíguo ou de risco, defira à policy e ao escalonamento.',
    '{boleto_cancel,company_campaign_remove}',
    '{confirm_before_write_policy,human_confirmation_policy}'
  ),
  -- 4. refund_intake — WRITE-INTENT (refund creation). Split from followup.
  (
    'refund_intake', 'decide', 'tool_mediated',
    'Abrir o processo inicial de reembolso coletando e validando as informações necessárias. Solicita a criação do reembolso apenas quando os dados de intake estiverem completos; a decisão de executar/confirmar é da policy e do dispatcher, nunca desta skill.',
    'Quando o cliente diz que pagou por engano, pede o dinheiro de volta, envia comprovante de pagamento, ou fornece dados de PIX/bancários para reembolso. Identifique a empresa, encontre o boleto/pagamento relacionado, colete o comprovante e os dados de PIX/conta, valide campos obrigatórios e inconsistências óbvias, e só então solicite a criação do reembolso. Explique protocolo e status inicial após a criação.',
    '{payment_verification,receipt_validate,bank_account_validate,refund_create,conversation_attachment_lookup}',
    '{confirm_before_write_policy,small_risk_write_policy,human_confirmation_policy}'
  ),
  -- 5. refund_followup — STATUS ONLY (no creation). Split from intake.
  (
    'refund_followup', 'extract', 'tool_mediated',
    'Consultar e explicar o status de um pedido de reembolso existente, sem abrir um novo reembolso.',
    'Quando o cliente pergunta sobre um reembolso existente, fornece um protocolo de reembolso, pergunta a data prevista de pagamento, ou pergunta se o comprovante final de reembolso está disponível. Busque por protocolo e CNPJ/empresa quando disponível; explique status, data prevista, histórico e pendências; recupere o comprovante final apenas quando disponível e permitido; evite abrir um novo reembolso quando o cliente só pede status.',
    '{refund_lookup,conversation_attachment_lookup,conversation_summary_generate}',
    '{}'
  ),
  -- 6. analyze_customer_documents — interpret attachments; reuses parsers (#416
  --    builds receipt_validate on parse_receipt/parse_image). Never approves.
  (
    'analyze_customer_documents', 'extract', 'tool_mediated',
    'Interpretar documentos e anexos enviados pelo cliente, extraindo sinais operacionais básicos. Não aprova reembolsos nem cancelamentos só com base na análise documental.',
    'Quando o cliente envia comprovante de pagamento, boleto, print de DDA, ou PDF/imagem relacionado ao caso. Recupere o anexo relevante da conversa/protocolo, identifique se é comprovante, boleto, print de DDA ou outro arquivo, e extraia sinais básicos como valor, data e identificadores.',
    '{conversation_attachment_lookup,receipt_validate}',
    '{}'
  ),
  -- 7. answer_boleto_proposal_questions — knowledge/context answers; no writes.
  (
    'answer_boleto_proposal_questions', 'compose', 'prompt_only',
    'Responder dúvidas de processo sobre operações de boleto proposta de forma curta, clara, cordial e adequada ao WhatsApp.',
    'Quando o cliente pergunta sobre boleto proposta, DDA, baixa, campanhas, pagamentos, reembolsos, ou processo de cancelamento/remoção. Prefira respostas de conhecimento/contexto; não solicite ferramentas de escrita por padrão; se a dúvida virar operacional, encaminhe para a skill de domínio apropriada.',
    '{}',
    '{}'
  ),
  -- 8. evaluate_escalation_need — detect legal intent / risk; create ticket.
  (
    'evaluate_escalation_need', 'diagnose', 'tool_mediated',
    'Identificar situações que não devem ser resolvidas automaticamente (jurídico, risco, fora de fluxo) e encaminhá-las à fila humana, sem dar aconselhamento jurídico.',
    'Quando o cliente menciona advogado, processo/ação judicial, pede o departamento jurídico, ameaça reclamação formal ou ação legal, o caso foge do fluxo padrão, ou sinais de risco aparecem na mensagem, histórico, documento ou contexto de pagamento. Detecte intenção jurídica, classifique o risco operacional, crie um ticket operacional quando necessário e resuma a conversa para a fila humana.',
    '{legal_intent_detect,case_risk_classify,operational_ticket_create,conversation_summary_generate}',
    '{}'
  )
) AS v(
  skill_descriptor, category, execution_mode,
  goal, when_to_use, allowed_tools, policy_descriptors
)
ON CONFLICT (tenant_id, COALESCE(agent_id, 'tenant_wide'), skill_descriptor, version)
  DO NOTHING;
