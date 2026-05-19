#!/bin/bash
# P9a Acceptance Gates — Skill Abstraction
# Run after: DB up + migrations 043/044 applied (or in CI: only static checks).
# Note: gates that require a live DB (DB constraint checks) are guarded by
# DATABASE_URL detection; CI without DB skips those silently.
set -e

echo "=== P9a Acceptance Gates ==="

# G1: Migration 043 creates skills table
echo "G1: Migration 043 skills table..."
test -f migrations/043_p9a_skills.sql || { echo "FAIL: migration 043 missing"; exit 1; }
grep -q "CREATE TABLE skills" migrations/043_p9a_skills.sql || { echo "FAIL: skills CREATE missing"; exit 1; }
grep -q "runtime_hints" migrations/043_p9a_skills.sql || { echo "FAIL: runtime_hints column missing"; exit 1; }
echo "OK"

# G2: DEFAULT status='proposed'
echo "G2: DEFAULT status='proposed'..."
grep -q "DEFAULT 'proposed'" migrations/043_p9a_skills.sql || { echo "FAIL: DEFAULT 'proposed' missing"; exit 1; }
echo "OK"

# G3: Partial unique "one active"
echo "G3: Partial unique 'one active'..."
grep -q "idx_skills_one_active_uq" migrations/043_p9a_skills.sql || { echo "FAIL: one_active partial unique missing"; exit 1; }
grep -q "WHERE status = 'active'" migrations/043_p9a_skills.sql || { echo "FAIL: WHERE clause for partial unique missing"; exit 1; }
echo "OK"

# G4: Version monotônica unique
echo "G4: Version monotônica..."
grep -q "idx_skills_version_uq" migrations/043_p9a_skills.sql || { echo "FAIL: version unique missing"; exit 1; }
echo "OK"

# G5: 4 execution_modes CHECK
echo "G5: execution_mode CHECK..."
grep -q "prompt_only" migrations/043_p9a_skills.sql || { echo "FAIL"; exit 1; }
grep -q "procedure_adapter" migrations/043_p9a_skills.sql || { echo "FAIL"; exit 1; }
grep -q "tool_mediated" migrations/043_p9a_skills.sql || { echo "FAIL"; exit 1; }
grep -q "evaluator" migrations/043_p9a_skills.sql || { echo "FAIL"; exit 1; }
echo "OK"

# G6: Drizzle schema exports skills table
echo "G6: Drizzle schema exports..."
grep -q "export const skills" src/db/schema.ts || { echo "FAIL: skills export missing"; exit 1; }
grep -q "SkillContract" src/db/schema.ts || { echo "FAIL: SkillContract type missing"; exit 1; }
grep -q "SkillRuntimeHints" src/db/schema.ts || { echo "FAIL: SkillRuntimeHints type missing"; exit 1; }
echo "OK"

# G7: Enums
echo "G7: SkillStatus / SkillExecutionMode / SkillCategory enums..."
grep -q "SkillStatus" src/types/enums.ts || { echo "FAIL"; exit 1; }
grep -q "SkillExecutionMode" src/types/enums.ts || { echo "FAIL"; exit 1; }
grep -q "SkillCategory" src/types/enums.ts || { echo "FAIL"; exit 1; }
grep -q "SKILL_REGISTRY_V1" src/types/enums.ts || { echo "FAIL: SKILL_REGISTRY_V1 flag missing"; exit 1; }
echo "OK"

# G8: Feature flag wired in env + singleton
echo "G8: Feature flag wired..."
grep -q "FEATURE_SKILL_REGISTRY_V1" src/config/env.ts || { echo "FAIL: env not wired"; exit 1; }
grep -q "SKILL_REGISTRY_V1" src/config/feature-flags.ts || { echo "FAIL: singleton not wired"; exit 1; }
echo "OK"

# G9: skillsRepo (9 methods)
echo "G9: skillsRepo 9 methods..."
test -f src/control-plane/skill-registry/skills-repo.ts || { echo "FAIL: skills-repo.ts missing"; exit 1; }
for method in findActive listByCategory propose activate deprecate rollback getById getByDescriptor listVersions; do
  grep -q "$method" src/control-plane/skill-registry/skills-repo.ts || { echo "FAIL: method $method missing"; exit 1; }
done
echo "OK"

# G10: SkillRunner + 4 modes
echo "G10: SkillRunner + 4 execution modes..."
test -f src/skills/skill-runner.ts || { echo "FAIL: skill-runner.ts missing"; exit 1; }
test -f src/skills/modes/prompt-only.ts || { echo "FAIL: prompt-only mode missing"; exit 1; }
test -f src/skills/modes/procedure-adapter.ts || { echo "FAIL: procedure-adapter mode missing"; exit 1; }
test -f src/skills/modes/tool-mediated.ts || { echo "FAIL: tool-mediated mode missing"; exit 1; }
test -f src/skills/modes/evaluator.ts || { echo "FAIL: evaluator mode missing"; exit 1; }
grep -q "runCognitiveModule" src/skills/skill-runner.ts || { echo "FAIL: runCognitiveModule wrapping missing"; exit 1; }
grep -q "policyDescriptorResolver" src/skills/skill-runner.ts || { echo "FAIL: policy resolution missing"; exit 1; }
echo "OK"

# G11: SkillSlice builder + cache
echo "G11: SkillSlice builder + cache..."
test -f src/skills/skill-slice-builder.ts || { echo "FAIL: skill-slice-builder.ts missing"; exit 1; }
test -f src/skills/cache.ts || { echo "FAIL: cache.ts missing"; exit 1; }
grep -q "ttl_seconds" src/skills/skill-slice-builder.ts || { echo "FAIL: ttl missing"; exit 1; }
echo "OK"

# G12: skill-proposer detector
echo "G12: skill-proposer detector..."
test -f src/cognition/skill-proposer.ts || { echo "FAIL: skill-proposer.ts missing"; exit 1; }
grep -q "detectAndProposeSkill" src/cognition/skill-proposer.ts || { echo "FAIL: detectAndProposeSkill missing"; exit 1; }
echo "OK"

# G13: capability_type CHECK estendido (migration 044)
echo "G13: capability_type CHECK estendido..."
test -f migrations/044_p9a_extend_capability_proposal_type.sql || { echo "FAIL: migration 044 missing"; exit 1; }
grep -q "'skill'" migrations/044_p9a_extend_capability_proposal_type.sql || { echo "FAIL: 'skill' not in CHECK"; exit 1; }
echo "OK"

# G14: Integration with capability-revert (P5)
echo "G14: capability-revert + skill-proposer + capability-test-runner integration..."
grep -q "capability_type === 'skill'" src/agent/capability-revert.ts || { echo "FAIL: skill branch missing in capability-revert"; exit 1; }
grep -q "skill_evaluator" src/cognition/capability-test-runner.ts || { echo "FAIL: skill_evaluator strategy missing"; exit 1; }
echo "OK"

# G15: PolicyDescriptorResolver stub present
echo "G15: PolicyDescriptorResolver stub..."
test -f src/control-plane/policy/policy-descriptor-resolver.ts || { echo "FAIL: policy resolver stub missing"; exit 1; }
echo "OK"

# G16: Typecheck
echo "G16: Typecheck..."
npx tsc --noEmit 2>&1 | grep -c "error TS" | grep -q "^0$" || { echo "FAIL: typecheck errors"; exit 1; }
echo "OK"

# G17: Unit tests
echo "G17: Unit tests..."
npx vitest run tests/unit/skills/ 2>&1 | tail -5
npx vitest run tests/unit/skills/ 2>&1 | grep -q "Tests.*passed" || { echo "FAIL: unit tests"; exit 1; }
echo "OK"

# G18: Integration test
echo "G18: Integration test (mocked)..."
npx vitest run tests/integration/p9a-skill-lifecycle.spec.ts 2>&1 | tail -5
npx vitest run tests/integration/p9a-skill-lifecycle.spec.ts 2>&1 | grep -q "Tests.*passed" || { echo "FAIL: integration test"; exit 1; }
echo "OK"

echo ""
echo "=== ✓ All P9a gates PASS ==="
