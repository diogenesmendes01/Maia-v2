-- Down da 145.
--
-- ─── O que este down recusa, e por quê ─────────────────────────────────────
--
-- Mesma régua dos downs da 140 e da 141: rollback não decide sozinho sobre
-- estado que alguém escolheu. Uma linha `hermes` é a decisão registrada de
-- ligar o Hermes naquele escopo, com o ator que a tomou. Derrubar a tabela com
-- ela presente apagaria a decisão e o autor sem deixar rastro.
--
-- Linhas `maia_react` não seguram o down: equivalem à ausência de linha, que já
-- é `maia_react`.
--
-- Turnos já pinados não dependem desta tabela (o pin mora em
-- `engine_turn_bindings`, 140), então o down não mexe em turno em voo.
--
-- Quem precisa mesmo apagar: volte as linhas para `maia_react` pela escrita CAS
-- (fica o ator), ou rode o DROP à mão depois da triagem.

BEGIN;

DO $$
DECLARE
  ligadas integer;
BEGIN
  IF to_regclass('agent_engine_policies') IS NOT NULL THEN
    SELECT count(*) INTO ligadas FROM agent_engine_policies WHERE engine = 'hermes';
    IF ligadas > 0 THEN
      RAISE EXCEPTION 'down da 145 recusado: % politica(s) com engine=hermes', ligadas
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS agent_engine_policies;

COMMIT;
