-- Reverse of 063: drop the outbound idempotency ledger.
--
-- The table is a runtime-only dedupe surface; rows are never the
-- source of truth for any other table (mensagens persists the
-- delivered-and-acked outbound separately). A rollback wipes the
-- ledger and the next post-rollback turn starts with an empty guard
-- — the legacy double-send risk window from PR #216 re-opens.
-- Document the regression in the runbook before pulling the trigger.
--
-- IF EXISTS so a partially-rolled-back environment is a no-op. No
-- CASCADE: nothing should depend on this table; an unexpected FK
-- should fail loudly rather than be silently dropped.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps the script in a transaction.

DROP INDEX IF EXISTS idx_outbound_messages_tenant_status;
DROP INDEX IF EXISTS idx_outbound_messages_turn_lookup;
DROP TABLE IF EXISTS outbound_messages;
