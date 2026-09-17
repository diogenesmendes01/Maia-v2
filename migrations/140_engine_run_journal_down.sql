-- Down da 140.
--
-- ─── O que este down NÃO faz, de propósito ─────────────────────────────────
--
-- Ele não tenta ser esperto. A spec (§5.10.2, item 4) diz que o down só pode
-- remover estrutura quando não houver run aberto, run bloqueado, chamada
-- incerta, outbox dependente ou projeção não tratada — e que, fora disso, a
-- opção segura é reverter o código e DEIXAR as tabelas.
--
-- Codificar esse inventário aqui seria transformar um rollback em decisão
-- automática sobre efeito desconhecido, que é exatamente o que a spec proíbe.
-- Então o arquivo faz a coisa mais honesta disponível num `.sql`: recusa-se a
-- rodar enquanto houver journal com trabalho não resolvido, e diz o que olhar.
--
-- Quem precisa mesmo apagar depois de uma triagem consciente roda os DROPs
-- manualmente, com o inventário na mão.

BEGIN;

DO $$
DECLARE
  abertos integer;
  incertas integer;
BEGIN
  IF to_regclass('public.engine_runs') IS NOT NULL THEN
    SELECT count(*) INTO abertos FROM engine_runs WHERE phase <> 'closed';
    IF abertos > 0 THEN
      RAISE EXCEPTION 'down da 140 recusado: % run(s) nao fechado(s) em engine_runs', abertos
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF to_regclass('public.engine_tool_calls') IS NOT NULL THEN
    SELECT count(*) INTO incertas FROM engine_tool_calls
      WHERE effect_evidence IN ('possible', 'unknown');
    IF incertas > 0 THEN
      RAISE EXCEPTION 'down da 140 recusado: % chamada(s) com efeito nao reconciliado', incertas
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS engine_run_events_append_only_trg ON engine_run_events;
DROP TRIGGER IF EXISTS engine_tool_calls_immutable_trg ON engine_tool_calls;
DROP TRIGGER IF EXISTS engine_runs_immutable_trg ON engine_runs;
DROP FUNCTION IF EXISTS engine_run_events_append_only();
DROP FUNCTION IF EXISTS engine_tool_calls_immutable_columns();
DROP FUNCTION IF EXISTS engine_runs_immutable_columns();

-- Ordem inversa das dependências: filhos antes do pai.
DROP TABLE IF EXISTS engine_projections;
DROP TABLE IF EXISTS engine_run_events;
DROP TABLE IF EXISTS engine_tool_calls;
DROP TABLE IF EXISTS engine_runs;
DROP TABLE IF EXISTS engine_turn_bindings;
DROP TABLE IF EXISTS conversation_controls;

COMMIT;
