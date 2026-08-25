-- Down de 118 — remove as colunas de execução do TTL do export.
--
-- SÓ PARA dev/CI. Em produção isto DESTRÓI EVIDÊNCIA de conformidade: depois
-- deste down não há mais como responder "este pacote cifrado com os dados de um
-- titular foi realmente removido, e quando?". A linha de auditoria
-- (`privacy_export_purged`) sobrevive ao rollback e permite reconstruir a
-- resposta, mas o predicado indexado — e a marcação que impede a segunda
-- varredura de auditar de novo — desaparecem. Com as colunas fora, todo export
-- vencido volta a ser candidato a cada passe.
--
-- ENVELOPE EXPLÍCITO. O runner de down usa `psql -v ON_ERROR_STOP=1 -f`, que é
-- autocommit por statement: sem BEGIN/COMMIT, um erro no meio deixaria o schema
-- num estado parcial já commitado — fail-open exatamente no caminho que existe
-- para desfazer.

BEGIN;

DROP INDEX IF EXISTS privacy_requests_export_purge_open_idx;

DROP INDEX IF EXISTS privacy_requests_export_sweep_idx;

ALTER TABLE privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_export_purge_chk;

ALTER TABLE privacy_requests DROP COLUMN IF EXISTS export_purged_at;

ALTER TABLE privacy_requests DROP COLUMN IF EXISTS export_purge_started_at;

COMMIT;
