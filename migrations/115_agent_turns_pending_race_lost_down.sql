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
-- POR QUE ESTE ARQUIVO É ATÔMICO (`BEGIN`/`COMMIT`), E O `_up` NÃO É
--   O procedimento canônico de rollback (`docs/runbooks/migrations.md`) roda
--   downs com `psql -v ON_ERROR_STOP=1 -f`, statement a statement. A versão
--   anterior deste arquivo era `DROP CONSTRAINT` + `ADD CONSTRAINT` SOLTOS: o
--   `DROP` commitava, e só então o `ADD` varria a tabela e falhava por causa das
--   linhas `pending_race_lost`. Ou seja, o rollback que "falha de propósito"
--   deixava `agent_turns` **sem** `agent_turns_status_outcome_chk` — removendo em
--   silêncio a compatibilidade estado/outcome que ele deveria preservar. Falhar
--   com a tabela desprotegida é pior que não falhar.
--
--   Com `BEGIN`/`COMMIT` a recusa é total: nada é commitado, a constraint que
--   estava lá continua lá. O `_up` não pode fazer o mesmo — ele precisa de
--   commits SEPARADOS para que a varredura de `VALIDATE` não corra sob o
--   ACCESS EXCLUSIVE do `DROP` (ver o cabeçalho do `_up`). São exigências
--   opostas porque os dois caminhos têm riscos opostos: o `_up` roda com
--   tráfego, o `_down` roda numa janela de manutenção e precisa ser tudo-ou-nada.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- PREFLIGHT EXPLÍCITA
--   O `DO` abaixo recusa ANTES de qualquer DDL e diz o motivo em português, com
--   a contagem. Sem ele a recusa viria do `ADD CONSTRAINT` como um 23514 cru
--   ("violates check constraint"), que descreve o sintoma e não a decisão.
--   As duas defesas são independentes de propósito: a preflight é o diagnóstico,
--   o `BEGIN`/`COMMIT` é a garantia. Só a segunda protege a tabela se alguém
--   um dia acrescentar aqui um statement que falhe por outro motivo.
--
-- Ordem do rollback de código: derrube primeiro o código que escreve o outcome
-- (`src/agent/core.ts` → `concludeTurn(turn, 'pending_race_lost')`), depois rode
-- este down. Na ordem inversa, um turno em voo tenta gravar um outcome que o
-- CHECK já recusa e a transição vira `TurnStateWriteError` em modo autoritativo.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM agent_turns WHERE outcome = 'pending_race_lost';
  IF n > 0 THEN
    RAISE EXCEPTION
      'down de 115 recusado: % turno(s) em agent_turns com outcome = ''pending_race_lost''', n
      USING HINT =
        'Essas linhas sao a evidencia de que a perna perdedora de uma race foi descartada. '
        'Decida explicitamente o que fazer com elas (exportar, reclassificar) antes de reverter. '
        'Nada foi alterado: a constraint agent_turns_status_outcome_chk continua como estava.';
  END IF;
END
$$;

-- `_v115` só existe se o `_up` morreu entre os dois statements da fase 3. Cair
-- aqui também é rollback: o nome temporário não pode sobreviver ao down.
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_outcome_chk_v115;

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

COMMIT;
