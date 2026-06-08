-- Down migration for 086_fix_human_confirmation_policy_scope.sql
--
-- Reverts human_confirmation_policy to the pre-086 state:
--   - scope back to '{}' (global)
--   - agent_id back to NULL (global)
--   - predicate value back to ["medium","high","critical"]
--
-- NOTE: The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); applied manually via `psql -f` per docs/runbooks/migrations.md.

UPDATE policy_rules
SET
  agent_id  = NULL,
  scope     = '{}'::jsonb,
  rule_body = rule_body
              || jsonb_build_object(
                   'predicate',
                   jsonb_build_object(
                     'kind',  'leaf',
                     'field', 'risk.level',
                     'op',    'in',
                     'value', '["medium","high","critical"]'::jsonb
                   )
                 )
WHERE tenant_id       = 'primary'
  AND rule_descriptor = 'human_confirmation_policy';
