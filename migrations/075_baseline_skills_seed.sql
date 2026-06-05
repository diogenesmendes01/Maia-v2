-- =====================================================================
-- Maia — Migration 075 (issue #410)
-- Seed the BASELINE SKILLS as governed, tenant-wide skill contracts.
--
-- WHY (issue #410): every runtime agent must have a minimal, conservative
-- capability floor — `baseline.core`. The TOOLS half of that floor is the
-- `baseline.core` pack (src/tools/packs.ts, granted per-agent — enforcement
-- is #408). This migration seeds the SKILLS half: 8 prompt_only / read-oriented
-- skills that compose ONLY baseline tools.
--
-- GOVERNANCE (invariant #6 — identity is governed, skills are never "born
-- active" by the AGENT):
--   These rows are seeded as `agent_id IS NULL` (TENANT-WIDE) with
--   `status='active'`, `proposed_by='system'`, `approved_by='system'`,
--   version=1. The skill selector already reads `agent_id IS NULL OR agent_id
--   = $agent`, so every agent in the tenant sees them. A SYSTEM seed marking
--   baseline skills active is a GOVERNED, AUDITABLE bootstrap — it is NOT the
--   agent self-approving its own profile. Mirrors the controlled-exception
--   pattern of migrations 037 (hard-limit policies) and 039 (founder biases),
--   which seed `active` rows directly for bootstrap.
--
-- IDEMPOTENT: `ON CONFLICT DO NOTHING` on the version-unique index
-- (idx_skills_version_uq = tenant_id, COALESCE(agent_id,'tenant_wide'),
-- skill_descriptor, version). Re-runs are safe; an operator-edited row is
-- never overwritten.
--
-- TENANT (invariant #1): seeded under the bootstrap tenant 'default' (same as
-- 037/039). Multi-tenant rollout seeds per tenant via the same idempotent
-- INSERT; nothing here is cross-tenant.
--
-- allowed_tools: each skill lists ONLY baseline.core tools (registered in
-- src/tools/_registry.ts by this same issue). No domain/financial tool appears
-- — the "fora do baseline" contract.
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration in a
-- transaction (no `-- maia:no-transaction` marker here).
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
  'default', NULL, v.skill_descriptor, v.category, 'prompt_only',
  v.goal, v.when_to_use, '{}'::jsonb, '[]'::jsonb,
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  v.allowed_tools::text[], '{}'::text[],
  '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
  'active', 1, 'system', 'baseline.core seed (issue #410)',
  'system', NOW(), NOW()
FROM (VALUES
  -- safe_conversation — conversa de forma segura, no escopo, sem inventar.
  (
    'safe_conversation', 'compose',
    'Conversar de forma segura e contextual, sem inventar fatos ou exceder o escopo.',
    'Sempre que precisar responder em linguagem natural dentro do escopo do interlocutor.',
    '{read_turn_context,recall_memory}'
  ),
  -- ask_clarification — pedir esclarecimento quando o pedido é ambíguo.
  (
    'ask_clarification', 'compose',
    'Pedir esclarecimento quando a intenção do interlocutor está ambígua ou incompleta.',
    'Quando o pedido é ambíguo, incompleto ou de baixa confiança e responder seria arriscado.',
    '{read_turn_context}'
  ),
  -- request_confirmation — pedir confirmação explícita antes de agir.
  (
    'request_confirmation', 'decide',
    'Pedir confirmação explícita ao interlocutor antes de executar uma ação.',
    'Antes de qualquer ação que exija um "sim" explícito; o agente pergunta, não age.',
    '{request_confirmation}'
  ),
  -- handoff_to_owner — escalar internamente para o dono.
  (
    'handoff_to_owner', 'decide',
    'Escalar a conversa para o dono do agente (hand-off interno) quando está fora da competência.',
    'Quando a situação excede o que o agente pode/deve resolver e precisa do dono.',
    '{handoff_to_owner,audit_decision}'
  ),
  -- remember_safe_fact — registrar fato seguro do interlocutor.
  (
    'remember_safe_fact', 'compose',
    'Registrar um fato seguro sobre o interlocutor (preferências, idioma) no escopo da pessoa.',
    'Quando o interlocutor revela uma preferência segura que ajuda atendimentos futuros.',
    '{remember_safe_fact}'
  ),
  -- retrieve_context — recuperar contexto autorizado (memória + turno).
  (
    'retrieve_context', 'compose',
    'Recuperar contexto autorizado (memória e histórico do turno) dentro do escopo.',
    'Quando responder bem exige relembrar memória ou o histórico recente da conversa.',
    '{recall_memory,read_turn_context}'
  ),
  -- explain_limitation — explicar honestamente o que não pode fazer.
  (
    'explain_limitation', 'compose',
    'Explicar de forma honesta que o agente não pode realizar algo, em vez de inventar.',
    'Quando o pedido exige uma capacidade/grant que o agente não tem (fail-closed).',
    '{explain_limitation}'
  ),
  -- audit_decision — registrar decisão e racional na trilha de auditoria.
  (
    'audit_decision', 'decide',
    'Registrar explicitamente uma decisão e seu racional na trilha de auditoria.',
    'Quando uma decisão relevante deve ficar rastreável (invariante #4).',
    '{audit_decision}'
  )
) AS v(skill_descriptor, category, goal, when_to_use, allowed_tools)
ON CONFLICT (tenant_id, COALESCE(agent_id, 'tenant_wide'), skill_descriptor, version)
  DO NOTHING;
