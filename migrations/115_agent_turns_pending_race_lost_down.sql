-- Down de 115 — volta o CHECK de `agent_turns` à lista fechada da 097, sem
-- `pending_race_lost`.
--
-- ATENÇÃO: este down FALHA se já existir turno terminal com
-- `outcome = 'pending_race_lost'` — e falhar é o comportamento correto. Um down
-- que apagasse ou reescrevesse essas linhas destruiria a evidência de que a
-- perna perdedora de uma race foi descartada em vez de reinterpretada, que é
-- exatamente o fato que a 115 existe para registrar. Quem precisar reverter em
-- ambiente com dados decide explicitamente o que fazer com elas antes.
--
-- Ordem do rollback de código: derrube primeiro o código que escreve o outcome
-- (`src/agent/core.ts` → `concludeTurn(turn, 'pending_race_lost')`), depois rode
-- este down. Na ordem inversa, um turno em voo tenta gravar um outcome que o
-- CHECK já recusa e a transição vira `TurnStateWriteError` em modo autoritativo.

ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_outcome_chk;

ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_outcome_chk CHECK (
  (status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter') AND outcome IS NULL)
  OR (status = 'completed' AND outcome IS NOT NULL AND outcome IN (
    'reply_delivered', 'reply_delivery_unknown', 'fallback_delivered',
    'no_reply_produced', 'pending_action_resolved', 'legacy_processed'
  ))
  OR (status = 'ignored' AND outcome IS NOT NULL AND outcome IN (
    'blocked_by_policy', 'identity_unknown', 'identity_blocked',
    'quarantined', 'rate_limited_silent', 'operator_cancelled'
  ))
  OR (status = 'superseded' AND outcome IS NOT NULL AND outcome = 'merged_into_turn')
  OR (status = 'dead_letter' AND outcome IS NOT NULL
      AND outcome IN ('retry_exhausted', 'operator_cancelled', 'unsafe_to_retry'))
);
