-- Down de 132 — remove a triagem do pedido de ferramenta.
--
-- ESTE DOWN RECUSA SE HOUVER ACEITE OU GAP FECHADO. E recusar é o correto.
--
--   Uma linha de `tool_request_issues` com `status='created'` corresponde a uma
--   ISSUE QUE EXISTE no GitHub. Apagar a linha não apaga a issue: apaga a única
--   prova local de que ela foi aberta, com qual chave de idempotência e a
--   partir de qual agregado. O efeito prático seria o oposto de rollback — na
--   próxima subida, o aceite do mesmo agregado abriria uma SEGUNDA issue, que
--   é exatamente o que a fatia existe para impedir.
--
--   Um gap com `resolved_at` preenchido guarda o fato "esta lacuna fechou
--   porque a ferramenta ficou disponível". Zerar a coluna devolve o gap ao
--   estado aberto e o worker de escalada volta a propor a ferramenta que já
--   existe. Também não é rollback: é regressão silenciosa.
--
--   O caminho para reverter COM dado é explícito e o operador decide antes:
--   exportar `tool_request_issues` (a chave de idempotência e o número da issue
--   são o que importa preservar), e decidir gap a gap se a resolução deve ser
--   desfeita. Depois disso as tabelas estão vazias e este down passa.
--
--   As linhas `pending`/`failed` NÃO bloqueiam: nenhuma delas corresponde a
--   efeito externo consumado. Elas são apagadas junto com a tabela, e o pior
--   caso é o dono aceitar de novo — o que é o comportamento certo, porque a
--   issue nunca foi aberta.
--
-- POR QUE `BEGIN`/`COMMIT` EXPLÍCITOS
--   O rollback canônico (`docs/runbooks/migrations.md`) roda downs com
--   `psql -v ON_ERROR_STOP=1 -f`, que AUTOCOMMITA statement a statement — não
--   há transação implícita envolvendo o arquivo. Sem o envelope, o primeiro
--   `DROP TABLE` commitaria antes de a recusa do preflight ter efeito prático,
--   e o banco ficaria com metade do recurso (colunas de resolução sem a tabela
--   de aviso, ou vice-versa). Um `_down` sem envelope é fail-open. Com
--   `BEGIN`/`COMMIT`, a recusa é total e nada é alterado.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- ORDEM DO ROLLBACK DE CÓDIGO: derrube PRIMEIRO o código que escreve — o
--   router `toolRequests` do console (`src/admin-ui/trpc/routers/tool-requests.ts`)
--   e os dois workers de `src/workers/tool-request-triage.ts` —, e só então
--   rode este down. Na ordem inversa, um aceite em voo tenta gravar numa
--   tabela que já não existe.

BEGIN;

DO $$
DECLARE
  n_issues INTEGER;
  n_resolvidos INTEGER;
  n_avisos INTEGER;
BEGIN
  SELECT count(*) INTO n_issues
    FROM tool_request_issues WHERE status = 'created';
  SELECT count(*) INTO n_resolvidos
    FROM agent_capability_gaps WHERE resolved_at IS NOT NULL;
  SELECT count(*) INTO n_avisos FROM tool_request_notifications;

  IF n_issues > 0 OR n_resolvidos > 0 OR n_avisos > 0 THEN
    RAISE EXCEPTION
      'down de 132 recusado: % issue(s) ja criada(s), % gap(s) fechado(s) e % aviso(s) ao agente',
      n_issues, n_resolvidos, n_avisos
      USING HINT =
        'Uma linha com status=created corresponde a uma issue que EXISTE no GitHub; apagar a linha '
        'apaga so a prova local e faz o proximo aceite abrir uma segunda issue. Um gap com '
        'resolved_at guarda o fato de que a ferramenta ficou disponivel; zera-lo devolve o gap ao '
        'estado aberto e o worker volta a pedir o que ja existe. Exporte tool_request_issues e '
        'decida gap a gap antes de reverter. Nada foi alterado.';
  END IF;
END
$$;

DROP TABLE tool_request_notifications;
DROP TABLE tool_request_issues;

DROP INDEX IF EXISTS caps_gaps_resolvidos_idx;
DROP INDEX IF EXISTS caps_gaps_abertos_idx;

ALTER TABLE agent_capability_gaps
  DROP CONSTRAINT IF EXISTS agent_capability_gaps_resolution_needs_reason;

ALTER TABLE agent_capability_gaps
  DROP COLUMN resolved_tool_name,
  DROP COLUMN resolved_reason,
  DROP COLUMN resolved_at;

COMMIT;
