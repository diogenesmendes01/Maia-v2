-- Down da 139.
--
-- Só é seguro enquanto NENHUMA FK apontar para esta unique. A 140 cria uma
-- (`engine_tool_calls_approval_fk`), então o down da 140 precisa rodar ANTES
-- deste — o Postgres recusaria de qualquer forma, mas a ordem está dita aqui
-- para que ninguém descubra isso no meio de um rollback.
--
-- `IF EXISTS` porque um down precisa ser repetível: rodar duas vezes não pode
-- transformar "já desfeito" em erro de operação.

BEGIN;

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_scope_id_uq;

COMMIT;
