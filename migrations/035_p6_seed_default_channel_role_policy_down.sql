-- Rollback contract (P6 seed down):
--   Removes ONLY the default-channel/default-role/default-policy seed rows
--   for (tenant='default', agent='default'). Non-default tenants' rows are
--   untouched. Run order: 035 (this) -> 034 -> 033 -> 032 -> 031. Idempotent:
--   re-running on an already-rolled-back DB is a no-op (DELETE matches zero
--   rows). Safe to run with FEATURE_MULTI_CHANNEL OFF — the resolver
--   short-circuits to default/default/null and never consults these rows.
DELETE FROM channel_policies WHERE tenant_id='default' AND agent_id='default';
DELETE FROM channels WHERE tenant_id='default' AND agent_id='default' AND external_id='default-channel';
DELETE FROM roles WHERE tenant_id='default' AND agent_id='default' AND role_key='default';
