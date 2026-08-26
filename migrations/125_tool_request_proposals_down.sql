-- Down de 125 — desfaz o "pedido de ferramenta": derruba a marcação
-- obrigatória, tira `tool_request` da lista fechada de `capability_type` e
-- remove o ledger de ocorrências do gap.
--
-- ESTE DOWN RECUSA SE HOUVER DADO. E recusar é o comportamento correto.
--   Uma proposta `tool_request` é a única forma persistida de "o agente tentou
--   fazer X, N vezes, nestes turnos, e não existe tool para isso" — e as
--   observações são a evidência que a sustenta. Um down que apagasse as duas
--   destruiria em silêncio o trabalho que a fatia existe para produzir, e o
--   destruiria justamente no ambiente onde ela já rodou. Quem precisar reverter
--   com dado decide EXPLICITAMENTE o que fazer com ele antes (exportar,
--   reclassificar) e roda de novo.
--
--   O precedente é o down da 117, pelo mesmo motivo: o valor da linha está em
--   ela existir, então apagá-la não é rollback, é perda.
--
-- POR QUE `BEGIN`/`COMMIT` EXPLÍCITOS
--   O rollback canônico (`docs/runbooks/migrations.md`) roda downs com
--   `psql -v ON_ERROR_STOP=1 -f`, que AUTOCOMMITA statement a statement — não
--   há transação implícita envolvendo o arquivo. Sem o envelope, o
--   `DROP CONSTRAINT` da marcação commitaria, o `DROP TABLE` seguinte falharia
--   (ou a recusa do preflight chegaria tarde demais) e o banco ficaria num
--   estado que nenhum dos dois lados desenhou: `capability_proposals` aceitando
--   `tool_request` SEM marcação obrigatória. Um `_down` sem envelope é
--   fail-open. Com `BEGIN`/`COMMIT`, a recusa é total e nada é alterado.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- ORDEM DO ROLLBACK DE CÓDIGO: derrube PRIMEIRO o código que escreve
--   (`src/cognition/tool-request/proposer.ts`, o wiring em
--   `src/workers/gap-escalation-monitor.ts` e o registro de observação em
--   `src/db/repositories/capability-repos.ts`), e só então rode este down. Na
--   ordem inversa, um worker em voo tenta gravar um `capability_type` que o
--   CHECK restaurado já recusa.

BEGIN;

-- LOCK EXCLUSIVE antes do preflight: sem ele, um INSERT concorrente entre a
-- contagem e o DDL escaparia da recusa e seria apagado pelo DROP. Mesmo motivo
-- do down da 058.
LOCK TABLE capability_proposals IN EXCLUSIVE MODE;
LOCK TABLE agent_capability_gap_observations IN EXCLUSIVE MODE;

DO $$
DECLARE
  n_propostas bigint;
  n_observacoes bigint;
BEGIN
  SELECT count(*) INTO n_propostas
    FROM capability_proposals WHERE capability_type = 'tool_request';
  SELECT count(*) INTO n_observacoes
    FROM agent_capability_gap_observations;

  IF n_propostas > 0 OR n_observacoes > 0 THEN
    RAISE EXCEPTION
      'down de 125 recusado: % proposta(s) tool_request e % observacao(oes) de gap',
      n_propostas, n_observacoes
      USING HINT =
        'Essas linhas sao o pedido de ferramenta e a evidencia (situacoes com trace, janela de '
        'frequencia) que o sustenta. Exporte ou reclassifique explicitamente antes de reverter. '
        'Nada foi alterado: o CHECK de capability_type e a tabela de observacoes continuam como estavam.';
  END IF;
END
$$;

DROP TABLE agent_capability_gap_observations;

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_tool_request_marking_check;

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

-- Volta EXATAMENTE à lista que a 058 deixou vigente.
ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other', 'holiday'
  ));

COMMIT;
