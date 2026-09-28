-- SC02 (spec maia-hermes §5.7.1 "runtime_pin" e §5.6.2 invariante 2) —
-- o PIN do turno é IMUTÁVEL.
--
-- `engine_turn_bindings` guarda a decisão que AUTORIZA um motor para o turno:
-- qual engine, com qual revisão de adaptador, sob qual digest de configuração e
-- qual versão de protocolo. A 140 já trancou o request (`request_json`,
-- `request_hash`, `request_key`) no journal do run; o binding ficou de fora, e
-- sem esta linha um `UPDATE` direto pelo psql — caminho em que ninguém passa
-- pelo repositório — troca a autorização DEPOIS do fato: o run continua com o
-- `engine_runs.pin` antigo enquanto o turno passa a apontar para outro motor, e
-- nenhuma auditoria sobre `engine_runs` percebe.
--
-- Não é "o código não atualiza": o repositório nunca deu UPDATE aqui. É o banco
-- recusando a escrita, como na 140, porque o banco é o último lugar por onde
-- toda escrita passa.
--
-- Sem tabela nova e sem coluna nova: uma função e um trigger BEFORE UPDATE.
-- DDL transacional (envelope BEGIN/COMMIT), como a 149.
BEGIN;

CREATE OR REPLACE FUNCTION engine_turn_bindings_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.engine IS DISTINCT FROM OLD.engine
     OR NEW.adapter_revision IS DISTINCT FROM OLD.adapter_revision
     OR NEW.configuration_digest IS DISTINCT FROM OLD.configuration_digest
     OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
     OR NEW.max_generations IS DISTINCT FROM OLD.max_generations THEN
    RAISE EXCEPTION 'engine_turn_bindings: coluna imutavel alterada (spec maia-hermes 5.7.1/5.6.2)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS engine_turn_bindings_immutable_trg ON engine_turn_bindings;

CREATE TRIGGER engine_turn_bindings_immutable_trg
  BEFORE UPDATE ON engine_turn_bindings
  FOR EACH ROW
  EXECUTE FUNCTION engine_turn_bindings_immutable_columns();

COMMIT;