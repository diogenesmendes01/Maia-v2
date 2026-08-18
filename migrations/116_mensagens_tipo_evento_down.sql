-- Reverte #577: `mensagens.tipo` volta aos cinco valores de 001_initial.sql.
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
-- Escolhemos (a), e restrito: apagamos SÓ as rows que o flush cria — 'evento' +
-- `direcao='out'` + `metadata->>'event_only' = 'true'`. Elas são placeholders
-- sem texto (`conteudo = ''`); nenhuma mensagem de conversa é perdida, e o
-- `audit_log` de cada chamada de ferramenta (escrito pelo próprio laço, antes do
-- flush) continua intacto — é ele, não esta row, que sustenta o invariante de
-- auditoria da §4. O que se perde é a reidratação do bloco "## Eventos
-- confirmados pelo backend" no turno seguinte.
--
-- Se, ao rodar o down, existir alguma row 'evento' FORA desse recorte, ela é de
-- outra origem que não conhecemos: o DELETE não a alcança e o ADD CONSTRAINT vai
-- falhar de propósito, em vez de apagar dado alheio em silêncio.

DELETE FROM mensagens
 WHERE tipo = 'evento'
   AND direcao = 'out'
   AND metadata->>'event_only' = 'true';

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_tipo_check
  CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'sistema'));
