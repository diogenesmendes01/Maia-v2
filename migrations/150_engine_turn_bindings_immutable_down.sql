-- Down da 150: derruba o trigger e a função de imutabilidade do PIN do turno.
-- O binding (engine_turn_bindings) e a tabela continuam existindo — o que sai é
-- só a recusa de UPDATE. DDL transacional, como o forward.
BEGIN;

DROP TRIGGER IF EXISTS engine_turn_bindings_immutable_trg ON engine_turn_bindings;
DROP FUNCTION IF EXISTS engine_turn_bindings_immutable_columns();

COMMIT;