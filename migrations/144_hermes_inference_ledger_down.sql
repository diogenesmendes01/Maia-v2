-- Down da 144.
--
-- ─── O que este down recusa, e por quê ─────────────────────────────────────
--
-- Mesma régua dos downs da 140 e da 141: rollback não decide sozinho sobre
-- dinheiro nem sobre efeito desconhecido. Recusa enquanto houver:
--
-- * tentativa sem desfecho (`reserved`) ou com custo desconhecido (`unknown`):
--   apagar a linha apagaria a única prova de que uma chamada paga pode ter
--   saído;
-- * conta com exposição reservada: o mesmo dinheiro, visto pelo lado da conta.
--
-- Quem precisa mesmo apagar depois de uma triagem consciente roda os DROPs
-- manualmente, com o inventário na mão.

BEGIN;

DO $$
DECLARE
  abertas integer;
  expostas integer;
BEGIN
  IF to_regclass('public.engine_inference_attempts') IS NOT NULL THEN
    SELECT count(*) INTO abertas FROM engine_inference_attempts
      WHERE state = 'reserved' OR accounting_status IN ('reserved', 'unknown');
    IF abertas > 0 THEN
      RAISE EXCEPTION 'down da 144 recusado: % tentativa(s) de inferencia sem custo conciliado', abertas
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF to_regclass('public.engine_budget_accounts') IS NOT NULL THEN
    SELECT count(*) INTO expostas FROM engine_budget_accounts WHERE reserved_microusd > 0;
    IF expostas > 0 THEN
      RAISE EXCEPTION 'down da 144 recusado: % conta(s) com exposicao reservada', expostas
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS engine_usage_events_append_only_trg ON engine_usage_events;
DROP TRIGGER IF EXISTS engine_inference_grants_guard_trg ON engine_inference_grants;
DROP FUNCTION IF EXISTS engine_usage_events_append_only();
DROP FUNCTION IF EXISTS engine_inference_grants_guard();

DROP INDEX IF EXISTS engine_usage_events_attempt_idx;
DROP INDEX IF EXISTS engine_inference_attempts_open_idx;
DROP INDEX IF EXISTS engine_inference_grants_run_idx;

DROP TABLE IF EXISTS engine_usage_events;
DROP TABLE IF EXISTS engine_inference_attempts;
DROP TABLE IF EXISTS engine_inference_grants;
DROP TABLE IF EXISTS engine_budget_accounts;

COMMIT;
