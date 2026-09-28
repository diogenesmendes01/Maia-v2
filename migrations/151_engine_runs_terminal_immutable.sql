-- SC02 (spec maia-hermes §5.6.2, invariante 2: "terminal aceito: imutáveis") —
-- o terminal aceito é imutável no CONTEÚDO, não só no hash.
--
-- A 140 trancou o terminal comparando SÓ `terminal_hash`:
--
--   IF OLD.terminal_hash IS NOT NULL AND NEW.terminal_hash IS DISTINCT FROM OLD.terminal_hash
--
-- O buraco que ficou: `UPDATE engine_runs SET terminal_json='{…outro…}'`
-- mantendo o hash antigo passava (`UPDATE 1`). O journal passava a guardar um
-- terminal que ninguém aceitou, e o leitor que confere o digest — justamente o
-- caminho que a 140 parecia proteger — não percebe nada, porque o hash
-- continua o do terminal antigo. A prova de QUAL conteúdo foi aceito deixa de
-- ser prova, que é o único motivo de o hash existir ao lado do jsonb.
--
-- Reproduzido em revisão independente (probe em BEGIN/ROLLBACK): run com
-- terminal `{"resultado":"sintetico"}` → `UPDATE … SET terminal_json =
-- '{"resultado":"ADULTERADO"}'` → `UPDATE 1`, hash intacto. E reproduzido de
-- novo aqui antes desta migration: `refinement-sc02-real-db.spec.ts`, caso
-- "terminal aceito é imutável no CONTEÚDO", 22 passed / 1 failed.
--
-- ─── Por que uma FUNÇÃO nova, e não `CREATE OR REPLACE` da função da 140 ────
--
-- Reescrever `engine_runs_immutable_columns()` exigiria TRANSCREVER a lista de
-- 15 colunas da 140; um erro de transcrição derrubaria em silêncio a proteção
-- de uma coluna que ninguém pediu para mexer — o defeito seria menor que a
-- correção. Esta migration não pode enfraquecer nada: ela ACRESCENTA um
-- trigger sobre a coluna que a 140 não verificava, e o `_down` derruba
-- exatamente o que subiu. Como os triggers BEFORE UPDATE disparam em ordem
-- alfabética de nome, `engine_runs_immutable_trg` (140) continua disparando
-- primeiro, então o conflito de hash preserva a mensagem e o ERRCODE de hoje.
--
-- ─── O que é "o mesmo terminal" ────────────────────────────────────────────
--
-- A coluna é `jsonb`: igualdade aqui é SEMÂNTICA (ordem de chaves não é dado
-- armazenado). É a granularidade certa, e não uma brecha — o `terminal_hash` é
-- o digest do JSON CANÔNICO do valor, então dois jsonb iguais têm,
-- necessariamente, o mesmo digest. Repetir o idêntico continua no-op; mudar o
-- VALOR é conflito.
--
-- Sem tabela nova, sem coluna nova, sem índice: uma função e um trigger
-- BEFORE UPDATE, DDL transacional em envelope BEGIN/COMMIT, como a 149/150.
BEGIN;

CREATE OR REPLACE FUNCTION engine_runs_terminal_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- "Aceito" = existe terminal, e o CHECK engine_runs_terminal_hash_chk
  -- garante que `terminal_json` e `terminal_hash` nascem e morrem juntos.
  -- Depois do aceite o PAR é imutável: não muda o conteúdo, não muda o hash,
  -- não volta a NULL. Repetir o idêntico não levanta nada.
  IF OLD.terminal_hash IS NOT NULL
     AND (NEW.terminal_json IS DISTINCT FROM OLD.terminal_json
          OR NEW.terminal_hash IS DISTINCT FROM OLD.terminal_hash) THEN
    RAISE EXCEPTION 'engine_runs: terminal ja aceito nao pode ser substituido (spec 5.6.2 invariante 2)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS engine_runs_terminal_immutable_trg ON engine_runs;

CREATE TRIGGER engine_runs_terminal_immutable_trg
  BEFORE UPDATE ON engine_runs
  FOR EACH ROW
  EXECUTE FUNCTION engine_runs_terminal_immutable_columns();

COMMIT;