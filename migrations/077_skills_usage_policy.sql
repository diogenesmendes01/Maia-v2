-- =====================================================================
-- Maia — Migration 077 (issue #409)
-- Add the NATIVE, typed `usage_policy` to `skills` and give the #410
-- baseline skills a safe, permissive policy.
--
-- WHY (issue #409): a skill must declare not just WHAT it does, but WHO it may
-- be used with, on WHICH channels, WHAT data it may access/expose, and whether
-- it needs trust / confirmation / a risk ceiling. Until now `skills` carried
-- goal/when_to_use/procedure/constraints/allowed_tools/policy_descriptors/
-- runtime_hints but NO native audience-governance fields, so nothing blocked a
-- skill by audience before selection/execution (the "customer asks 'how was the
-- day?' → daily_business_summary leaks internal data" risk).
--
-- This column is the strongly-typed `SkillUsagePolicy` (validated by Zod in
-- src/skills/usage-policy.ts). It COMPLEMENTS — never replaces — the existing
-- `constraints` and `policy_descriptors` columns (the descriptor/DSL layer
-- stays intact; this is the per-audience admission layer).
--
-- NULL semantics (DOCUMENTED no-policy default): a skill with `usage_policy IS
-- NULL` (or `{}`) is treated by the runtime (usage-policy.ts) as the
-- CONSERVATIVE DEFAULT — admitted ONLY for internal/trusted audiences
-- (owner/manager/employee/accountant/system_user), data_scope
-- internal_business_summary, exposure internal_only, requires trusted_internal.
-- An operator must OPT IN (declare a policy) to expose a new skill to external
-- audiences. We therefore leave the column NULLABLE and do NOT force a default
-- at the DB layer — the conservative default lives in code so it can evolve
-- without a migration.
--
-- BASELINE SKILLS (#410): the 8 tenant-wide baseline skills are
-- safe-conversation / clarify / confirm / handoff / audit skills usable by ANY
-- audience. We do NOT rely on the NULL conservative default for them (that
-- would hide them from customers/leads); instead we backfill an EXPLICIT
-- permissive-but-safe policy so they keep working for every audience. The
-- backfill is scoped to the exact tenant-wide baseline rows seeded by migration
-- 075 (agent_id IS NULL, proposed_by='system', the 8 known descriptors) and is
-- idempotent (only touches rows whose usage_policy is still NULL).
--
-- BLAST RADIUS: low. Additive nullable column; one targeted UPDATE of the
-- baseline rows. No constraint changes, no FK changes.
--
-- TENANT (invariant #1): the column is per-row; the baseline backfill matches
-- the same tenant-wide rows 075 seeded (no cross-tenant write).
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration in a
-- transaction (no `-- maia:no-transaction` marker here). Mirrors migration 076.
-- =====================================================================

-- 1. Add the native usage_policy column (nullable JSONB — NULL = conservative
--    default, resolved in code).
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS usage_policy JSONB;

COMMENT ON COLUMN skills.usage_policy IS
  'Issue #409 SkillUsagePolicy (Zod-validated in src/skills/usage-policy.ts): allowed/blocked audience, allowed/blocked channels, data_scope, exposure_policy, requires_auth_level, requires_confirmation, blocked_when_risk_at_or_above. NULL = conservative internal-only default (resolved in code). Complements constraints/policy_descriptors.';

-- 2. Backfill the #410 baseline skills with a safe, permissive policy so they
--    remain usable by every audience (they are safe-conversation / clarify /
--    confirm / handoff / audit skills with NO domain side effects). Idempotent:
--    only rows whose usage_policy is still NULL are touched, so a re-run or an
--    operator edit is never overwritten.
--
--    Policy shape:
--      allowed_audience      : ALL audience types (every interlocutor).
--      data_scope            : ['public_info'] — baseline skills never expose
--                              internal/financial/operational data; the most
--                              they touch is safe per-pessoa facts + turn
--                              context, which is public-safe to the subject.
--      exposure_policy       : 'public_safe'.
--      requires_auth_level   : 'known_external' — the lowest permitting floor
--                              (a known external contact); they do NOT require
--                              trusted_internal, so customers/leads can use them.
--      requires_confirmation : false.
UPDATE skills
SET usage_policy = jsonb_build_object(
  'allowed_audience', jsonb_build_array(
    'owner', 'manager', 'employee', 'accountant',
    'customer', 'vendor', 'lead', 'system_user'
  ),
  'data_scope', jsonb_build_array('public_info'),
  'exposure_policy', 'public_safe',
  'requires_auth_level', 'known_external',
  'requires_confirmation', false
)
WHERE agent_id IS NULL
  AND proposed_by = 'system'
  AND usage_policy IS NULL
  AND skill_descriptor IN (
    'safe_conversation',
    'ask_clarification',
    'request_confirmation',
    'handoff_to_owner',
    'remember_safe_fact',
    'retrieve_context',
    'explain_limitation',
    'audit_decision'
  );
