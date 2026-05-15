-- Rollback contract (P6 down):
--   Destructive — drops channel_policies and all rows (incl. JSONB
--   by_context_guards configs). Run order: 035 -> 034 -> 033 (this) -> 032
--   -> 031. No FK dependencies point back to channel_policies; safe to drop
--   even with rows. Configuration is lost: operators tuning min_confidence /
--   cooldown / required_strength_delta must re-apply after re-up.
DROP INDEX IF EXISTS channel_policies_tenant_agent_idx;
DROP TABLE IF EXISTS channel_policies;
