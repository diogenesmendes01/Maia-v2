BEGIN;

-- Rollback da 135 (issue #635).
--
-- ENVELOPE EXPLÍCITO, ao contrário do `_down` da 122 — e a diferença é
-- estrutural, não de gosto. Lá o rollback precisava de `DROP INDEX
-- CONCURRENTLY`, que o PostgreSQL recusa dentro de bloco de transação. Aqui
-- não precisa: `DROP COLUMN` derruba TODO índice que depende da coluna, e a
-- `mensagens_outbound_history_uq` depende. Com um statement a menos, o arquivo
-- inteiro cabe numa transação — e um `_down` aplicado com
-- `psql -v ON_ERROR_STOP=1 -f` (autocommit por statement) deixa de poder parar
-- no meio.
--
-- ORDEM: a CHECK primeiro. Ela não impede o `DROP COLUMN` (o Postgres a
-- derrubaria junto), mas derrubá-la explicitamente deixa o arquivo legível como
-- o inverso exato da 135 em vez de depender de cascata implícita.
--
-- `DROP COLUMN` é catálogo (a coluna é marcada `attisdropped`, a heap não é
-- reescrita), então o ACCESS EXCLUSIVE é instantâneo. O espaço volta no próximo
-- VACUUM FULL/rewrite — irrelevante para um rollback.
--
-- O QUE ESTE ROLLBACK PERDE, declarado: as chaves de dedupe já gravadas. Depois
-- dele, a reconciliação volta ao predicado `metadata->>'in_reply_to'` da #633,
-- com o falso positivo de multipart que a 135 existe para corrigir. Não rodar
-- automaticamente durante incidente — ver docs/runbooks/migrations.md.

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_outbound_history_direcao_chk;

ALTER TABLE mensagens DROP COLUMN IF EXISTS outbound_id;

COMMIT;
