-- Down da 113. Ordem inversa das dependências: os filhos referenciam
-- `onboarding_runs` com ON DELETE RESTRICT, então eles caem primeiro.
DROP INDEX IF EXISTS onboarding_step_results_step_uq;
DROP INDEX IF EXISTS onboarding_step_results_key_uq;
DROP TABLE IF EXISTS onboarding_step_results;

DROP INDEX IF EXISTS onboarding_events_scope_idx;
DROP INDEX IF EXISTS onboarding_events_run_idx;
DROP TABLE IF EXISTS onboarding_events;

DROP INDEX IF EXISTS onboarding_runs_single_live_bootstrap_uq;
DROP INDEX IF EXISTS onboarding_runs_active_scope_uq;
DROP INDEX IF EXISTS onboarding_runs_expiry_idx;
DROP INDEX IF EXISTS onboarding_runs_target_scope_idx;
DROP INDEX IF EXISTS onboarding_runs_actor_scope_idx;
DROP TABLE IF EXISTS onboarding_runs;
