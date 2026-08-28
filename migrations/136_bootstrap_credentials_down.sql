-- Rollback da 136 (issue 519). Derruba as duas tabelas do bootstrap global.
--
-- Ordem importa: `bootstrap_completions` referencia `bootstrap_credentials`.
--
-- CONSEQUENCIA OPERACIONAL, explicita: derrubar `bootstrap_completions` apaga
-- o marcador de "bootstrap ja' feito". Se houver founder no sistema, o caminho
-- de bootstrap volta a depender da checagem de aplicacao, mais fraca. Rodar
-- este _down num sistema JA' inicializado e' seguro apenas porque a criacao de
-- credencial tambem exige ausencia de identidade administrativa global — mas o
-- bloqueio deixa de ser um fato do banco ate a 136 ser reaplicada.

BEGIN;

DROP TABLE IF EXISTS bootstrap_completions;
DROP TABLE IF EXISTS bootstrap_credentials;

COMMIT;
