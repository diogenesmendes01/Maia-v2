-- =====================================================================
-- Maia — Migration 086 (issue #446)
-- Fix human_confirmation_policy: reescopa ao role boleto e ajusta predicado.
--
-- WHY: Migration 078 semeou human_confirmation_policy com scope='{}' (global
-- para todo o tenant) e agent_id=NULL. Isso faz a policy disparar em toda
-- conversa do tenant 'primary', não apenas nas atendidas pelo role
-- whatsapp_boleto_proposta_attendant. Além disso, o predicado inclui
-- risk.level='medium', escalando casos de risco médio que o LLM consegue
-- resolver diretamente.
--
-- WHAT THIS MIGRATION DOES
--   1. Atualiza scope para '{"roles":["whatsapp_boleto_proposta_attendant"]}',
--      restringindo a policy ao role de atendimento de boleto (migration 079).
--   2. Atualiza o predicado — remove 'medium' do valor do operador 'in',
--      deixando apenas risk.level ∈ {high, critical}.
--   3. Define agent_id='primary' (era NULL — global).
--   4. Garante status='active'.
--
-- IDEMPOTENT: UPDATE com WHERE sobre tenant_id + rule_descriptor. Re-execução
-- é no-op quando scope/predicate/agent_id já estão corretos.
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration in a
-- transaction. Mirrors 079-085.
-- =====================================================================

UPDATE policy_rules
SET
  agent_id  = 'primary',
  scope     = '{"roles":["whatsapp_boleto_proposta_attendant"]}'::jsonb,
  rule_body = rule_body
              || jsonb_build_object(
                   'predicate',
                   jsonb_build_object(
                     'kind',  'leaf',
                     'field', 'risk.level',
                     'op',    'in',
                     'value', '["high","critical"]'::jsonb
                   )
                 ),
  status    = 'active'
WHERE tenant_id       = 'primary'
  AND rule_descriptor = 'human_confirmation_policy';
