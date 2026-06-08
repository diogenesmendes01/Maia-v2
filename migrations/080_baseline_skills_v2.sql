-- =====================================================================
-- Maia — Migration 080 (issue #448)
-- Baseline skills v2: upgrade 5 skills to tool_mediated + seed 3 new
-- tool_mediated baseline skills.
--
-- WHY (issue #448): migration 075 seeded 8 baseline skills all as
-- `prompt_only`. Since then, three new tools were added to
-- BASELINE_CORE_PACK v2 in src/tools/packs.ts:
--   risk_signal_classify, conversation_summary_compose,
--   conversation_state_update
-- With those tools now available in the pack, five existing baseline
-- skills should be upgraded to `tool_mediated` (version=2) so the
-- runtime actually invokes the tools they declare. Three entirely new
-- baseline skills are also added at version=1 to cover the new tools:
--   escalate_on_risk, summarization, manage_conversation_state.
--
-- WHAT THIS MIGRATION DOES
--   1. Inserts v2 (tool_mediated) rows for 5 converted skills:
--        safe_conversation, retrieve_context, handoff_to_owner,
--        remember_safe_fact, audit_decision
--      The v1 prompt_only rows (migration 075) are LEFT INTACT —
--      version pinning lets legacy skill-selectors keep using v1 until
--      the runtime is updated to select the latest active version.
--   2. Inserts v1 (tool_mediated) rows for 3 new skills:
--        escalate_on_risk, summarization, manage_conversation_state
--
-- SKILLS THAT REMAIN prompt_only (NO v2 rows):
--   ask_clarification  — pure language composition from current input;
--                        no runtime context mutation needed.
--   request_confirmation — compositional; the request_confirmation tool
--                          itself has no side effects that need wiring here.
--   explain_limitation  — pure language composition; no runtime writes.
--
-- respect_privacy is NOT seeded as a separate skill. It is covered by:
--   safe_conversation (reads context safely), explain_limitation
--   (honest refusal), audit_decision (audit-trail). See docs/architecture/
--   concerns/capability-taxonomy.md for rationale.
--
-- BASELINE_CORE_PACK v2 tools (the ONLY tools baseline skills may
-- reference):
--   read_turn_context, recall_memory, remember_safe_fact,
--   request_confirmation, handoff_to_owner, audit_decision,
--   explain_limitation, risk_signal_classify,
--   conversation_summary_compose, conversation_state_update
--
-- GOVERNANCE (invariant #6 — identity is governed; skills are never
-- "born active" by the AGENT):
--   All rows are seeded as `agent_id IS NULL` (TENANT-WIDE) with
--   `status='active'`, `proposed_by='system'`, `approved_by='system'`.
--   Mirrors the controlled-exception pattern of migrations 037, 039,
--   and 075 which seed `active` rows directly for governed bootstrap.
--
-- IDEMPOTENT: `ON CONFLICT DO NOTHING` on the version-unique index
-- (idx_skills_version_uq = tenant_id, COALESCE(agent_id,'tenant_wide'),
-- skill_descriptor, version). Re-runs are safe; an operator-edited row
-- is never overwritten.
--
-- TENANT (invariant #1): seeded under the bootstrap tenant 'default'
-- (same as 037/039/075). Multi-tenant rollout seeds per tenant via the
-- same idempotent INSERT; nothing here is cross-tenant.
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward
-- migration in a transaction (no `-- maia:no-transaction` marker here).
-- Mirrors 075/076/079.
-- =====================================================================

INSERT INTO skills (
  tenant_id, agent_id, skill_descriptor, category, execution_mode,
  goal, when_to_use, procedure, constraints,
  input_schema, output_schema, allowed_tools, policy_descriptors,
  success_criteria, failure_modes, runtime_hints,
  status, version, proposed_by, proposed_reason,
  approved_by, approved_at, activated_at
)
SELECT
  'default', NULL, v.skill_descriptor, v.category, v.execution_mode,
  v.goal, v.when_to_use, v.procedure::jsonb, '[]'::jsonb,
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  v.allowed_tools::text[], '{}'::text[],
  '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
  'active', v.version, 'system', 'baseline.core v2 seed (issue #448)',
  'system', NOW(), NOW()
FROM (VALUES
  -- ----------------------------------------------------------------
  -- CONVERTED TO tool_mediated (version=2)
  -- ----------------------------------------------------------------

  -- safe_conversation v2 — now reads turn context, recalls memory, and
  -- classifies risk before responding. risk_signal_classify is wired so
  -- the agent detects potential risk on every turn, not just on escalate.
  (
    'safe_conversation', 'tool_mediated', 'tool_mediated',
    'Conversar de forma segura e contextual, lendo o turno e memória autorizada, sem inventar fatos ou exceder o escopo.',
    'Sempre que precisar responder em linguagem natural dentro do escopo do interlocutor.',
    '{"system_prompt":"Responda de forma segura e contextual. Use read_turn_context para entender o turno, recall_memory para recuperar contexto autorizado, e risk_signal_classify para avaliar o risco antes de responder."}',
    '{read_turn_context,recall_memory,risk_signal_classify}',
    2
  ),
  -- retrieve_context v2 — now explicitly uses both context tools; the
  -- tool_mediated mode allows the runtime to log which tool produced
  -- which piece of context (auditability, invariant #4).
  (
    'retrieve_context', 'tool_mediated', 'tool_mediated',
    'Recuperar contexto autorizado (memória e histórico do turno) dentro do escopo.',
    'Quando responder bem exige relembrar memória ou o histórico recente da conversa.',
    '{"system_prompt":"Recupere contexto usando read_turn_context e recall_memory. Retorne somente o contexto autorizado no escopo do interlocutor."}',
    '{read_turn_context,recall_memory}',
    2
  ),
  -- handoff_to_owner v2 — now composes a summary before escalating so
  -- the owner receives structured context, not just a raw dump.
  (
    'handoff_to_owner', 'tool_mediated', 'tool_mediated',
    'Escalar a conversa para o dono do agente com contexto resumido e decisão auditada.',
    'Quando a situação excede o que o agente pode/deve resolver e precisa do dono.',
    '{"system_prompt":"Resuma a conversa com conversation_summary_compose, registre a decisão com audit_decision e escale com handoff_to_owner."}',
    '{handoff_to_owner,audit_decision,conversation_summary_compose}',
    2
  ),
  -- remember_safe_fact v2 — pairs the write (remember_safe_fact) with
  -- an audit record (audit_decision) so every memory write is traceable.
  (
    'remember_safe_fact', 'tool_mediated', 'tool_mediated',
    'Registrar um fato seguro sobre o interlocutor e auditar o registro.',
    'Quando o interlocutor revela uma preferência segura que ajuda atendimentos futuros.',
    '{"system_prompt":"Use remember_safe_fact para persistir o fato seguro e audit_decision para registrar a decisão de armazenar."}',
    '{remember_safe_fact,audit_decision}',
    2
  ),
  -- audit_decision v2 — now explicitly tool_mediated so the runtime can
  -- enforce that the audit_decision tool is always called (not bypassed).
  (
    'audit_decision', 'tool_mediated', 'tool_mediated',
    'Registrar explicitamente uma decisão e seu racional na trilha de auditoria via tool.',
    'Quando uma decisão relevante deve ficar rastreável (invariante #4).',
    '{"system_prompt":"Use audit_decision para registrar a decisão e o racional na trilha de auditoria."}',
    '{audit_decision}',
    2
  ),

  -- ----------------------------------------------------------------
  -- NEW SKILLS (version=1, tool_mediated)
  -- ----------------------------------------------------------------

  -- escalate_on_risk — first-class baseline skill for risk-triggered
  -- escalation. Classifies risk, audits the verdict, and escalates when
  -- risk is HIGH or CRITICAL. Decoupled from safe_conversation so the
  -- skill selector can trigger it independently on high-risk turns.
  (
    'escalate_on_risk', 'decide', 'tool_mediated',
    'Avaliar o risco do turno, auditar e escalar para o dono se o risco for alto ou crítico.',
    'Quando o turno apresenta sinais de risco que exigem intervenção humana antes de agir.',
    '{"system_prompt":"Classifique o risco com risk_signal_classify. Se risk for HIGH ou CRITICAL, registre com audit_decision e escale com handoff_to_owner."}',
    '{risk_signal_classify,handoff_to_owner,audit_decision}',
    1
  ),
  -- summarization — exposes conversation_summary_compose as a standalone
  -- baseline skill so any role (not just handoff_to_owner) can request a
  -- structured summary for context, registration, or handoff.
  (
    'summarization', 'compose', 'tool_mediated',
    'Produzir um resumo estruturado da conversa atual usando o sumarizador compartilhado.',
    'Quando for necessário resumir a conversa para contexto, handoff ou registro.',
    '{"system_prompt":"Use conversation_summary_compose para produzir um resumo estruturado da conversa atual."}',
    '{conversation_summary_compose}',
    1
  ),
  -- manage_conversation_state — persists lightweight state markers
  -- (topic, progress, flags) via conversation_state_update. Scoped to
  -- agent_state namespace; all updates are logged at the tool level.
  (
    'manage_conversation_state', 'decide', 'tool_mediated',
    'Atualizar o estado leve da conversa no escopo do agente de forma rastreável.',
    'Quando precisar persistir marcações de estado interno da conversa (tópico, progresso, flags).',
    '{"system_prompt":"Use conversation_state_update para persistir marcações de estado leve da conversa no namespace agent_state."}',
    '{conversation_state_update}',
    1
  )
) AS v(skill_descriptor, category, execution_mode, goal, when_to_use, procedure, allowed_tools, version)
ON CONFLICT (tenant_id, COALESCE(agent_id, 'tenant_wide'), skill_descriptor, version)
  DO NOTHING;
