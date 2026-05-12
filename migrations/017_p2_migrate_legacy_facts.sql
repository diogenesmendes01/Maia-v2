-- P2: migra agent_facts legados pra memory_entry com needs_review=true
-- Migration CONSERVADORA: tudo nasce como 'unknown' + needs_review=true, BLOQUEIA uso no prompt
-- até classifier reprocessar e classificar.

INSERT INTO memory_entry (
  tenant_id, agent_id, interlocutor_id, content, memory_type, scope_type,
  subject_id, sensitivity, proactive_use, mention_allowed, needs_review, created_at
)
SELECT
  af.tenant_id,
  af.agent_id,
  NULL,
  CONCAT(af.chave, ': ', af.valor::text) AS content,
  'unknown' AS memory_type,
  CASE af.escopo
    WHEN 'global' THEN 'agent'
    WHEN 'role' THEN 'role'
    WHEN 'conversation' THEN 'conversation'
    ELSE 'agent'
  END AS scope_type,
  af.escopo AS subject_id,
  'medium' AS sensitivity,
  false AS proactive_use,
  false AS mention_allowed,
  true AS needs_review,
  af.created_at
FROM agent_facts af;
