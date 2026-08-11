-- 095 down — remove o store de evidência de aprovação.
--
-- ATENÇÃO (runbook de rollback do cap. 2): em produção com dados, prefira
-- DESABILITAR criação/consumo no aplicativo a rodar este down — as rows são
-- evidência de decisões humanas. Este down existe para dev/CI.

DROP TABLE IF EXISTS approval_decisions;
DROP TABLE IF EXISTS approval_requests;
