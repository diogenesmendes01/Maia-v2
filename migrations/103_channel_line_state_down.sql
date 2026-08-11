-- 103 down — remove o estado operacional de linha + a fila de comandos.
--
-- ATENÇÃO (rollback da issue #518): este down NÃO toca em `channels` nem em
-- credenciais de linha (auth dirs em `lines/<channel_id>/`). Derrubar esta
-- tabela apenas devolve o console à listagem read-only anterior — sessões já
-- pareadas continuam conectadas e canais verificados continuam ativos.
-- Material cifrado eventualmente pendente morre junto, que é o desejado.
DROP TABLE IF EXISTS channel_line_state;
