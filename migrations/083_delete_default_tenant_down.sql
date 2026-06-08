-- Reverse 083: re-seed the `default` tenant/agent registry rows.
--
-- In the full down chain this runs FIRST (reverse order), so the `default` FK
-- targets exist before 081_down re-homes data back from `primary` to `default`.
-- Restores ONLY the registry rows (matching 007's original seed values); the
-- typed seeds (channel/role/policy/biases/skills) are moved back by 081_down.

INSERT INTO tenants (id, nome, status)
  VALUES ('default', 'Default Tenant (Maia legacy)', 'active')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (id, tenant_id, nome, status)
  VALUES ('default', 'default', 'Maia (legacy)', 'active')
  ON CONFLICT (id) DO NOTHING;
