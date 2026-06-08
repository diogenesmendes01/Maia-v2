-- issue #323 — seed the reserved `primary` tenant/agent.
--
-- `primary` is the single-tenant runtime home that replaces the legacy
-- `default` bucket. Unlike `system` (014), `primary` is an ORDINARY tenant: it
-- passes the `'default'`-literal guard with no special-casing, so once the
-- runtime moves off `default` we can reject `default` fail-closed everywhere.
--
-- Must run BEFORE 081 (rehome) — the rehome re-points FK columns at `primary`,
-- so the FK targets must already exist. ON CONFLICT for idempotency.
-- NOTE: no BEGIN/COMMIT — migrate.ts already wraps each migration in a tx.

INSERT INTO tenants (id, nome, status)
  VALUES ('primary', 'Primary (single-tenant runtime)', 'active')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (id, tenant_id, nome, status)
  VALUES ('primary', 'primary', 'Maia', 'active')
  ON CONFLICT (id) DO NOTHING;
