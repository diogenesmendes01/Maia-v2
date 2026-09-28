-- Rollback da 151: derruba só o trigger e a função do CONTEÚDO do terminal.
-- A imutabilidade que a 140 já dava (troca de `terminal_hash` recusada)
-- continua exatamente como estava — este down não a desfaz, porque não foi
-- esta migration que a criou.
BEGIN;

DROP TRIGGER IF EXISTS engine_runs_terminal_immutable_trg ON engine_runs;

DROP FUNCTION IF EXISTS engine_runs_terminal_immutable_columns();

COMMIT;