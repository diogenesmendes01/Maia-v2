-- Down da 141.
--
-- ─── O que este down recusa, e por quê ─────────────────────────────────────
--
-- Mesma régua do down da 140: um rollback não pode virar decisão automática
-- sobre efeito desconhecido. A tabela de comandos é OUTBOX de intenção de
-- cancelamento/reconciliação (§8.2.4) — apagá-la enquanto houver comando
-- aceito cuja drenagem não convergiu jogaria fora a única cópia durável de um
-- cancelamento que talvez nunca tenha chegado ao motor remoto. O §8.2.3 é
-- explícito em que "falha de rede mantém trabalho de reconciliação
-- persistido"; um DROP silencioso é a forma mais completa de não manter.
--
-- Também recusa enquanto houver conversa fora de `bot`: derrubar o ledger de
-- comandos com uma conversa pausada deixaria o estado sem a evidência de quem
-- pausou, por que, e sob qual chave — que é precisamente o que a auditoria do
-- §8.2.3 passo 4 existe para garantir.
--
-- Quem precisa mesmo apagar depois de uma triagem consciente roda os DROPs
-- manualmente, com o inventário na mão.

BEGIN;

DO $$
DECLARE
  pendentes integer;
  pausadas integer;
BEGIN
  IF to_regclass('public.conversation_control_commands') IS NOT NULL THEN
    SELECT count(*) INTO pendentes FROM conversation_control_commands
      WHERE status = 'accepted' AND drain_status IS DISTINCT FROM 'complete';
    IF pendentes > 0 THEN
      RAISE EXCEPTION 'down da 141 recusado: % comando(s) aceito(s) sem drenagem confirmada', pendentes
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF to_regclass('public.conversation_controls') IS NOT NULL THEN
    SELECT count(*) INTO pausadas FROM conversation_controls WHERE mode <> 'bot';
    IF pausadas > 0 THEN
      RAISE EXCEPTION 'down da 141 recusado: % conversa(s) fora de bot (pausing/human)', pausadas
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END
$$;

DROP INDEX IF EXISTS conversation_control_commands_outbox_idx;
DROP INDEX IF EXISTS conversation_control_commands_scope_idx;
DROP TABLE IF EXISTS conversation_control_commands;

COMMIT;
