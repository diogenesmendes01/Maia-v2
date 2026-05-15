-- Rollback contract (P6 down):
--   Destructive — drops the role-selector audit trail. Run order: 035 -> 034
--   (this) -> 033 -> 032 -> 031. AUDIT LOSS: dropping this table erases the
--   forensic record of every role decision (who suggested, who decided, why).
--   For compliance/post-mortem use cases, dump the table to a backup file
--   before running. No FK dependencies point back to this table.
DROP INDEX IF EXISTS role_selector_tenant_agent_idx;
DROP INDEX IF EXISTS role_selector_conversa_idx;
DROP TABLE IF EXISTS role_selector_decisions;
