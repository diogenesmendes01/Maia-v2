-- 109 down — remove a saga de onboarding (issue #519).
--
-- ATENÇÃO: este down NÃO desprovisiona nada. Tenants, agentes, profiles,
-- papéis, políticas e canais criados por uma run continuam existindo — a saga
-- é o TRILHO, não o recurso. Derrubá-la apenas devolve o sistema ao
-- provisionamento manual anterior (tRPC router a router).
--
-- Antes de rodar: confirme que nenhuma run está em `activating` (a issue exige
-- essa verificação no rollback). Uma run presa em `activating` significa que a
-- ativação commitou parcialmente; apagar a tabela apaga a única evidência.
--
--   SELECT id, tenant_id, agent_id, state FROM onboarding_runs
--    WHERE state NOT IN ('active','cancelled','failed_terminal');
--
-- Ordem inversa das FKs (RESTRICT no forward: filhos primeiro).
DROP TABLE IF EXISTS onboarding_step_results;
DROP TABLE IF EXISTS onboarding_events;
DROP TABLE IF EXISTS onboarding_runs;
