-- 113 down — desfaz a criação idempotente, os resultados conclusivos tipados e
-- o ponto de retomada da saga de onboarding (issue #519, review do PR #541).
--
-- ATENÇÃO — o que este down DESTRÓI, e por quê ele mesmo assim é o certo:
--
--   * `creation_idempotency_key_hash` / `creation_payload_hash`: derrubá-las
--     devolve a criação de run ao comportamento não-idempotente. Um retry
--     posterior à reversão volta a abrir uma segunda run. É recuperável (o
--     índice único de run viva por tenant continua barrando a segunda run viva
--     enquanto ele existir — mas ele também cai aqui).
--   * `failed_step` / `resume_state`: uma run parada em `failed_retryable`
--     perde o ponto de retomada. Depois desta reversão o código ANTIGO aceita
--     qualquer passo a partir daquele estado, que é exatamente o defeito
--     original; o código NOVO recusaria tudo. Em ambos os casos a run precisa
--     ser cancelada e reaberta, não "consertada".
--   * `onboarding_step_results.outcome_kind/outcome_code/outcome_message`: as
--     linhas de negação e de cancelamento gravadas no ledger passam a ser
--     INDISTINGUÍVEIS de sucessos — o replay de uma chave que negou devolveria
--     "concluído". Por isso a reversão APAGA essas linhas antes de derrubar as
--     colunas: perder o replay de uma negativa é ruim; devolver sucesso no
--     lugar dela é pior.
--
-- Antes de rodar, veja quantas runs perdem retomada e quantas conclusões não-
-- sucesso serão apagadas:
--
--   SELECT state, count(*) FROM onboarding_runs
--    WHERE failed_step IS NOT NULL GROUP BY state;
--   SELECT outcome_kind, count(*) FROM onboarding_step_results
--    WHERE outcome_kind <> 'success' GROUP BY outcome_kind;

DELETE FROM onboarding_step_results WHERE outcome_kind <> 'success';

DROP INDEX IF EXISTS onboarding_step_results_outcome_idx;

ALTER TABLE onboarding_step_results DROP CONSTRAINT IF EXISTS onboarding_step_results_outcome_code_ck;
ALTER TABLE onboarding_step_results DROP CONSTRAINT IF EXISTS onboarding_step_results_outcome_kind_ck;

ALTER TABLE onboarding_step_results DROP COLUMN IF EXISTS outcome_message;
ALTER TABLE onboarding_step_results DROP COLUMN IF EXISTS outcome_code;
ALTER TABLE onboarding_step_results DROP COLUMN IF EXISTS outcome_kind;

ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_retry_point_ck;
ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_resume_state_ck;
ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_failed_step_ck;

ALTER TABLE onboarding_runs DROP COLUMN IF EXISTS resume_state;
ALTER TABLE onboarding_runs DROP COLUMN IF EXISTS failed_step;

DROP INDEX IF EXISTS onboarding_runs_one_live_per_tenant_uq;
DROP INDEX IF EXISTS onboarding_runs_creation_key_uq;

ALTER TABLE onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_creation_key_pair_ck;

ALTER TABLE onboarding_runs DROP COLUMN IF EXISTS creation_payload_hash;
ALTER TABLE onboarding_runs DROP COLUMN IF EXISTS creation_idempotency_key_hash;
