-- Rollback da 118 (issue #505, shadow mode).
--
-- ENVELOPE TRANSACIONAL EXPLÍCITO — e por que ele é obrigatório aqui.
--
-- `_down` NÃO é executado pelo runner de migrations: o runbook
-- (docs/runbooks/migrations.md §"Rolling back") manda aplicá-lo com
-- `psql -v ON_ERROR_STOP=1 -f`. O `psql` roda em AUTOCOMMIT: cada statement
-- comita sozinho. Sem `BEGIN`/`COMMIT`, um arquivo que falhasse no terceiro
-- statement deixaria os dois primeiros aplicados e o banco num meio-termo que
-- ninguém declarou — fail-OPEN, exatamente o que um rollback não pode ser.
-- Com o envelope, `ON_ERROR_STOP=1` aborta e o `ROLLBACK` implícito devolve o
-- schema inteiro ao estado anterior.
--
-- PRÉ-CONDIÇÃO: a 119 já foi revertida. Os índices e as constraints CHECK da
-- 119 referenciam estas colunas; dropar a coluna antes cairia em CASCADE
-- implícito e apagaria objetos que o `_down` da 119 espera encontrar.
--
-- CUSTO DESTE ROLLBACK: apaga as sequências de ingresso já alocadas. Uma
-- stream que voltar a existir depois começa do 1 de novo, e as mensagens
-- antigas ficam sem ordem canônica — não há como reconstruí-la (a ordem estava
-- justamente nestas colunas). Reverter é seguro APENAS enquanto o protocolo é
-- shadow, isto é, enquanto nada lê estas colunas para decidir. Assim que a
-- exclusão por stream entrar (fase 5 do rollout), este `_down` deixa de ser
-- reversão e passa a ser perda de estado de escalonamento.
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.

BEGIN;

DROP TABLE IF EXISTS agent_stream_sequences;

ALTER TABLE agent_turns
  DROP COLUMN IF EXISTS last_ingress_seq,
  DROP COLUMN IF EXISTS first_ingress_seq,
  DROP COLUMN IF EXISTS stream_key_version,
  DROP COLUMN IF EXISTS stream_key;

ALTER TABLE mensagens
  DROP COLUMN IF EXISTS ingress_seq,
  DROP COLUMN IF EXISTS stream_key_version,
  DROP COLUMN IF EXISTS stream_key;

COMMIT;
