-- 115 — novo outcome terminal `pending_race_lost` para `agent_turns`.
--
-- O DEFEITO QUE ISSO FECHA
--   Quando duas respostas do usuário chegam em paralelo para a MESMA pergunta
--   pendente, uma vence o `SELECT … FOR UPDATE` de
--   `pendingQuestionsRepo.findActiveForUpdate` e a outra perde. O invariante de
--   exatamente-uma-vez está intacto (issue #545): a ação é despachada uma vez
--   só, e a perna perdedora é auditada como `pending_race_lost`.
--
--   O problema era o que acontecia com a perna perdedora DEPOIS. O gate
--   colapsava esse desfecho em `{ kind: 'no_pending' }`, e `src/agent/core.ts`
--   lia isso como "não havia pendência nenhuma" e rodava o turno normal do
--   agente (ReAct) sobre uma mensagem que já tinha sido CLASSIFICADA como
--   resposta à pendência. Um "sim" que significava "opção sim da pergunta X"
--   virava um comando novo e livre para o LLM — mudança de significado num
--   caminho que, por definição, só existe sob concorrência.
--
--   O gate passa a devolver `{ kind: 'race_lost' }` e o core conclui o turno
--   sem ReAct. Este outcome é o registro durável dessa conclusão.
--
-- POR QUE `ignored`, E NÃO `completed`
--   `src/runtime/turns/contract.ts` reserva `completed` a turnos que EXECUTARAM
--   até o fim — entregaram resposta ou concluíram um determinismo de negócio —
--   e define `ignored` como "descarte intencional por regra explícita". A perna
--   perdedora não executou nada: quem despachou a ação foi o outro turno.
--   Marcá-la `completed` + `pending_action_resolved` afirmaria que ESTE turno
--   resolveu a pendência, o que é falso e apagaria a distinção forense entre a
--   perna vencedora e a perdedora justamente no cenário em que ela importa.
--
--   Como todo outcome de `ignored`, a conclusão vira uma linha
--   `turn_ignored_by_policy` em `audit_log` (`concludeTurn`), ao lado do
--   `pending_race_lost` que `src/agent/pending-resolver.ts` já escreve. Duas
--   linhas, dois fatos: a race foi perdida, e o turno foi descartado por isso.
--
-- ESCOPO DA MUDANÇA
--   Só a lista fechada de `status = 'ignored'` no CHECK composto muda. As duas
--   outras constraints da 097 (presença do outcome e vocabulário de status)
--   ficam intactas, e nenhuma linha existente é reescrita: o valor é NOVO, então
--   nenhuma row atual pode violar o CHECK ampliado. Espelha 1:1 `TERMINAL_OUTCOMES`
--   em `src/runtime/turns/contract.ts` — `tests/integration/agent-turns-real-db.spec.ts`
--   gera a matriz completa a partir daquelas constantes e falha se divergirem.
--
--   `ALTER TABLE … DROP CONSTRAINT` + `ADD CONSTRAINT` pega ACCESS EXCLUSIVE na
--   tabela pelo tempo da revalidação. `agent_turns` é quente, então o ADD entra
--   como `NOT VALID` (não varre a tabela, não bloqueia escrita concorrente por
--   mais que o catálogo) e a validação vem depois em `VALIDATE CONSTRAINT`, que
--   só toma SHARE UPDATE EXCLUSIVE. O DROP anterior é inevitável e é curto.

ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_outcome_chk;

ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_outcome_chk CHECK (
  (status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter') AND outcome IS NULL)
  OR (status = 'completed' AND outcome IS NOT NULL AND outcome IN (
    'reply_delivered', 'reply_delivery_unknown', 'fallback_delivered',
    'no_reply_produced', 'pending_action_resolved', 'legacy_processed'
  ))
  OR (status = 'ignored' AND outcome IS NOT NULL AND outcome IN (
    'blocked_by_policy', 'identity_unknown', 'identity_blocked',
    'quarantined', 'rate_limited_silent', 'operator_cancelled',
    'pending_race_lost'
  ))
  OR (status = 'superseded' AND outcome IS NOT NULL AND outcome = 'merged_into_turn')
  OR (status = 'dead_letter' AND outcome IS NOT NULL
      AND outcome IN ('retry_exhausted', 'operator_cancelled', 'unsafe_to_retry'))
) NOT VALID;

ALTER TABLE agent_turns VALIDATE CONSTRAINT agent_turns_status_outcome_chk;
