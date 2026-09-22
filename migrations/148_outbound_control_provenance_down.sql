-- Down da 148.
--
-- ─── O que este down derruba, e o que ele NÃO pode derrubar ───────────────
--
-- Derruba as três colunas de proveniência e os dois CHECKs. Isso é reversível
-- de verdade: nenhuma outra tabela referencia estas colunas, e o predicado de
-- egresso que as lê (`outboundEgressAuthorizedSql`) sai junto com o código que
-- o down acompanha.
--
-- O que NÃO volta é a informação: `origin` e o par `control_id/control_epoch`
-- são o único registro de quem escreveu cada saída e sob qual regime. Um
-- rollback apaga isso para sempre — as colunas podem ser recriadas, os valores
-- não.
--
-- ─── Por que este down não recusa, diferente dos da 145 e 147 ─────────────
--
-- Lá a tabela GUARDA uma decisão (ligar o Hermes, subir um degrau) e apagá-la
-- apagaria a decisão e o autor. Aqui as colunas são PROVENIÊNCIA de linhas que
-- continuam existindo: o outbound não some, a entrega não muda de estado, e a
-- conversa não fica num limbo. O que se perde é rastro, e rastro perdido é o
-- preço declarado de um rollback — não um estado incoerente que o banco deva
-- impedir.
--
-- O que ele de fato reabre é a janela entre commit e envio, porque sem `origin`
-- o fence não consegue separar a fala do bot da fala do operador e seria
-- obrigado a reter as duas. Quem rodar este down precisa saber disso: a
-- proteção do §8.2.4 depois do commit deixa de existir.

BEGIN;

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_control_provenance_chk;

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_origin_chk;

ALTER TABLE outbound_messages
  DROP COLUMN IF EXISTS control_epoch,
  DROP COLUMN IF EXISTS control_id,
  DROP COLUMN IF EXISTS origin;

COMMIT;
