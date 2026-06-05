-- Down migration for 077_skills_usage_policy.sql
-- WARNING: destructive — drops the `skills.usage_policy` column (and every
-- declared / baseline-backfilled SkillUsagePolicy). After this, the runtime
-- has no native usage policies to evaluate; the candidate filter + gate 4.6
-- fall back to the conservative in-code default for every skill (which would
-- hide baseline skills from external audiences until re-applied).
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain only);
-- they are applied manually via `psql -f` per docs/runbooks/migrations.md.

ALTER TABLE skills DROP COLUMN IF EXISTS usage_policy;
