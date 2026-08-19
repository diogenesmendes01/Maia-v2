-- Down de 116 — `mensagens.tipo` volta aos cinco valores da 001_initial.sql.
--
-- CUIDADO — o down É DESTRUTIVO por necessidade. Depois do up, o flush do
-- react-loop grava rows `tipo='evento'`; restaurar o CHECK antigo com elas na
-- tabela falha na validação da constraint (`ALTER TABLE ... ADD CONSTRAINT`
-- valida as linhas existentes). Precisamos decidir o que fazer com essas linhas
-- ANTES de restaurar, e há duas opções:
--
--   (a) DELETE — descarta o rastro de ferramentas dos turnos sem outbound;
--   (b) reclassificar para um valor admitido — mantém a linha, mas mente sobre
--       o que ela é e ainda a esconde do `isEventOnly` do prompt-builder pelo
--       fallback de `conteudo` vazio.
--
-- Escolhemos (a), e restrito ao FORMATO COMPLETO que o flush produz hoje
-- (`flushUnconfirmedToolSummaries`, `src/agent/react-loop.ts`): `direcao='out'`,
-- `conteudo=''`, `midia_url IS NULL`, `metadata.event_only=true`,
-- `metadata.in_reply_to` presente, `metadata.flush_reason` no vocabulário
-- fechado de `ReActExitReason` e `ferramentas_chamadas` com pelo menos um item
-- (o helper retorna cedo quando não há nenhum). Nenhuma mensagem de conversa é
-- perdida, e o `audit_log` de cada chamada de ferramenta (escrito pelo próprio
-- laço, ANTES do flush) continua intacto — é ele, não esta row, que sustenta o
-- invariante de auditoria da §4. O que se perde é a reidratação do bloco
-- "## Eventos confirmados pelo backend" no turno seguinte.
--
-- POR QUE O PREDICADO É ESSE TAMANHO TODO
--   A versão anterior testava só `tipo`/`direcao`/`event_only`. O texto
--   prometia apagar "SÓ as rows que o flush cria" e destacava `conteudo = ''`,
--   mas o predicado não olhava nem `conteudo` nem `flush_reason`: qualquer
--   produtor futuro que reusasse aqueles três marcadores seria apagado em
--   silêncio, embora este mesmo arquivo declare que origem desconhecida deve
--   fazer o down FALHAR. Predicado largo e contrato estreito não podem conviver;
--   quem cede é o predicado.
--
-- ORIGEM DESCONHECIDA => RECUSA, E A RECUSA É O `ADD CONSTRAINT`
--   Se sobrar qualquer row `tipo='evento'` fora do recorte acima, o
--   `ADD CONSTRAINT` da última fase a encontra e aborta com 23514
--   ("violates check constraint"). É de propósito: o down não apaga dado de
--   origem que não conhece.
--
--   Por que a recusa NÃO é uma preflight `DO` nomeada, como na 115: lá o
--   critério é um valor de coluna (`outcome = 'pending_race_lost'`), e a
--   preflight o repete em uma linha. Aqui o critério é o COMPLEMENTO do recorte
--   do DELETE — uma preflight teria que reescrever o predicado inteiro negado, e
--   duas cópias de um predicado deste tamanho divergem. Com o `ADD CONSTRAINT`
--   como juiz existe UMA definição do recorte: o que o DELETE não levou, ele
--   recusa. O diagnóstico o operador tira em um SELECT (abaixo), sem precisar
--   que o arquivo o duplique.
--
--   Para ver o que sobrou antes de decidir:
--     SELECT id, direcao, conteudo IS NULL AS conteudo_null,
--            metadata->>'event_only'   AS event_only,
--            metadata->>'flush_reason' AS flush_reason,
--            jsonb_array_length(ferramentas_chamadas) AS n_tools
--       FROM mensagens WHERE tipo = 'evento';
--
-- POR QUE ESTE ARQUIVO É ATÔMICO (`BEGIN`/`COMMIT`), E O `_up` NÃO É
--   O procedimento canônico de rollback (`docs/runbooks/migrations.md`) roda
--   downs com `psql -v ON_ERROR_STOP=1 -f`, em autocommit por statement. A
--   versão anterior deste arquivo tinha `DELETE` + `DROP CONSTRAINT` +
--   `ADD CONSTRAINT` SOLTOS: o `DELETE` e o `DROP` commitavam, e só então o
--   `ADD` varria a tabela e falhava por causa da row desconhecida. Ou seja, o
--   rollback que "falha de propósito" já tinha apagado os placeholders
--   conhecidos e deixado `mensagens.tipo` sem CHECK NENHUM — fail-closed no
--   comentário, fail-open na execução, e o pior dos dois mundos: perde dado E
--   remove a garantia.
--
--   Com `BEGIN`/`COMMIT` a recusa é total: nada é commitado, a constraint que
--   estava lá continua lá e as rows continuam lá. O `_up` não pode fazer o
--   mesmo — ele precisa de commits SEPARADOS para que a varredura de `VALIDATE`
--   não corra sob o ACCESS EXCLUSIVE do `DROP` (ver o cabeçalho do `_up`). São
--   exigências opostas porque os dois caminhos têm riscos opostos: o `_up` roda
--   com tráfego, o `_down` roda numa janela de manutenção e precisa ser
--   tudo-ou-nada.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- Ordem do rollback de código: derrube primeiro o código que grava a row
-- (`flushUnconfirmedToolSummaries`), depois rode este down. Na ordem inversa, um
-- turno em voo tenta gravar `tipo='evento'` num CHECK que já recusa — o `catch`
-- do helper engole e o rastro some, que é exatamente o defeito da #577.

BEGIN;

DELETE FROM mensagens
 WHERE tipo = 'evento'
   AND direcao = 'out'
   AND conteudo = ''
   AND midia_url IS NULL
   AND metadata->>'event_only' = 'true'
   AND metadata->>'in_reply_to' IS NOT NULL
   AND metadata->>'flush_reason' IN (
         'iteration_cap', 'empty_final_text', 'reasoner_failed', 'outbound_failure'
       )
   AND jsonb_typeof(ferramentas_chamadas) = 'array'
   AND jsonb_array_length(ferramentas_chamadas) > 0;

-- `_v116` só existe se o `_up` morreu entre os dois statements da fase 3. Cair
-- aqui também é rollback: o nome temporário não pode sobreviver ao down.
ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check_v116;

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_tipo_check
  CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'sistema'));

COMMIT;
