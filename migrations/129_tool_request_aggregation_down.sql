-- Down de 129 — remove o agrupamento de pedidos de ferramenta por similaridade.
--
-- ESTE DOWN RECUSA SE HOUVER MEMBRO. E recusar é o comportamento correto.
--   Um membro NÃO-REPRESENTANTE não tem linha em `capability_proposals`: o
--   pedido dele existe SÓ aqui, em `original_spec` (intenção, situações com
--   link de trace, janela de frequência, rascunho de contrato). Apagar a tabela
--   apagaria pedidos inteiros — não o agrupamento, os PEDIDOS. Isso não é
--   rollback, é perda, e o precedente já está posto pelos downs da 117 e da 125.
--
--   O caminho para reverter COM dado é explícito e o operador decide antes:
--   destacar os membros (`detached_at`, que os devolve à condição de pedido
--   isolado e é o que a fatia chama de reversibilidade), exportar
--   `original_spec`, ou reemitir cada membro como proposta própria. Depois
--   disso a tabela está vazia e este down passa.
--
-- POR QUE `BEGIN`/`COMMIT` EXPLÍCITOS
--   O rollback canônico (`docs/runbooks/migrations.md`) roda downs com
--   `psql -v ON_ERROR_STOP=1 -f`, que AUTOCOMMITA statement a statement — não
--   há transação implícita envolvendo o arquivo. Sem o envelope, o primeiro
--   `DROP TABLE` commitaria antes de a recusa do preflight ter efeito prático,
--   e o banco ficaria com metade do recurso: membros sem agregado, ou agregados
--   sem membros e com o contador congelado. Um `_down` sem envelope é
--   fail-open. Com `BEGIN`/`COMMIT`, a recusa é total e nada é alterado.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- ORDEM DO ROLLBACK DE CÓDIGO: derrube PRIMEIRO o código que escreve
--   (`src/cognition/tool-request/aggregation.ts` e a chamada dele em
--   `src/cognition/tool-request/proposer.ts`), e só então rode este down. Na
--   ordem inversa, um worker em voo tenta inserir numa tabela que já não existe
--   e o gap perde a proposta em vez de perder só a agregação.
--
-- ESTE DOWN NÃO DESFAZ A 125. Ele não toca em `capability_proposals`,
--   `agent_capability_gaps` nem `agent_capability_gap_observations` — a fatia B
--   nunca escreveu nelas, e é por isso que revertê-la é uma operação local.

BEGIN;

-- LOCK EXCLUSIVE antes do preflight: sem ele, um INSERT concorrente entre a
-- contagem e o DDL escaparia da recusa e seria apagado pelo DROP. Mesmo motivo
-- do down da 125.
LOCK TABLE tool_request_aggregates IN EXCLUSIVE MODE;
LOCK TABLE tool_request_aggregate_members IN EXCLUSIVE MODE;

DO $$
DECLARE
  n_agregados bigint;
  n_membros bigint;
BEGIN
  SELECT count(*) INTO n_agregados FROM tool_request_aggregates;
  SELECT count(*) INTO n_membros FROM tool_request_aggregate_members;

  IF n_agregados > 0 OR n_membros > 0 THEN
    RAISE EXCEPTION
      'down de 129 recusado: % agregado(s) e % membro(s) de pedido de ferramenta',
      n_agregados, n_membros
      USING HINT =
        'Membro nao-representante NAO tem linha em capability_proposals: o pedido dele existe so '
        'em tool_request_aggregate_members.original_spec. Destaque (detached_at), exporte ou '
        'reemita cada membro antes de reverter. Nada foi alterado.';
  END IF;
END
$$;

DROP TABLE tool_request_aggregate_members;
DROP TABLE tool_request_aggregates;

COMMIT;
