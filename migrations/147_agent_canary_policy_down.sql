-- Down da 147.
--
-- ─── O que este down recusa, e por quê ─────────────────────────────────────
--
-- Mesma régua dos downs da 140, 141 e 145: rollback não decide sozinho sobre
-- estado que alguém escolheu. Uma linha acima de `off` é a decisão registrada
-- de habilitar um degrau para um agente, com o ator que a tomou e a evidência
-- de aceite contra a qual ele a tomou. Derrubar a tabela com ela presente
-- apagaria a decisão, o autor e a evidência sem deixar rastro — e a evidência
-- é precisamente o artefato que o §10 exige que exista.
--
-- Linhas `off` não seguram o down: equivalem à ausência de linha, que já é
-- `off`.
--
-- Quem precisa mesmo apagar: volte os degraus para `off` pela escrita CAS
-- (fica o ator da descida), ou rode o DROP à mão depois da triagem.

BEGIN;

DO $$
DECLARE
  habilitados integer;
BEGIN
  IF to_regclass('agent_canary_policy') IS NOT NULL THEN
    SELECT count(*) INTO habilitados FROM agent_canary_policy WHERE stage <> 'off';
    IF habilitados > 0 THEN
      RAISE EXCEPTION 'down da 147 recusado: % agente(s) com degrau acima de off', habilitados
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS agent_canary_policy;

COMMIT;
