-- Issue #227 (down): drop the outbound idempotency ledger. The dispatch code
-- gates use of this table behind a feature flag so reverting the migration
-- while the wiring is still present is safe (the wiring no-ops without the
-- table once the flag is off). Re-running the up migration is idempotent
-- (CREATE TABLE IF NOT EXISTS).
DROP INDEX IF EXISTS idx_outbound_messages_tenant_created;
DROP TABLE IF EXISTS outbound_messages;
