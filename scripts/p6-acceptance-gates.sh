#!/bin/bash
# P6 Acceptance Gates — run after DB up + P0+P1+P2+P3+P4+P5+P6 migrations applied
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/8: migrations 031-035 (UP + DOWN) + table/seed checks ==="
if [ -f "migrations/031_p6_channels.sql" ] \
  && [ -f "migrations/031_p6_channels_down.sql" ] \
  && [ -f "migrations/032_p6_roles.sql" ] \
  && [ -f "migrations/032_p6_roles_down.sql" ] \
  && [ -f "migrations/033_p6_channel_policies.sql" ] \
  && [ -f "migrations/033_p6_channel_policies_down.sql" ] \
  && [ -f "migrations/034_p6_role_selector_decisions.sql" ] \
  && [ -f "migrations/034_p6_role_selector_decisions_down.sql" ] \
  && [ -f "migrations/035_p6_seed_default_channel_role_policy.sql" ] \
  && [ -f "migrations/035_p6_seed_default_channel_role_policy_down.sql" ] \
  && grep -q "CREATE TABLE channels" migrations/031_p6_channels.sql \
  && grep -q "CREATE TABLE roles" migrations/032_p6_roles.sql \
  && grep -q "CREATE TABLE channel_policies" migrations/033_p6_channel_policies.sql \
  && grep -q "CREATE TABLE role_selector_decisions" migrations/034_p6_role_selector_decisions.sql \
  && grep -q "DO \$\$" migrations/035_p6_seed_default_channel_role_policy.sql; then
  echo "[GATE 1/8] schema/migration check ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/8] schema/migration check ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/8: vitest runs clean ==="
if npx vitest run \
  tests/unit/enums-p6.spec.ts \
  tests/unit/db-schema-p6.spec.ts \
  tests/unit/channels-repo.spec.ts \
  tests/unit/roles-repo.spec.ts \
  tests/unit/channel-policies-repo.spec.ts \
  tests/unit/role-selector-decisions-repo.spec.ts \
  tests/unit/channel-resolver.spec.ts \
  tests/unit/role-selector-llm-suggester.spec.ts \
  tests/unit/role-selector-deterministic.spec.ts \
  tests/unit/role-selector-policy-decider.spec.ts \
  tests/unit/role-selector-oscillation-tracker.spec.ts \
  tests/unit/role-selector-engine.spec.ts \
  tests/unit/role-audit-always-recorded.spec.ts \
  tests/unit/prompt-builder-role-section.spec.ts \
  tests/integration/p6-channel-role-policy.spec.ts; then
  echo "[GATE 2/8] vitest runs clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/8] vitest runs clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/8: typecheck ==="
if npx tsc --noEmit; then
  echo "[GATE 3/8] typecheck ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/8] typecheck ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/8: policy-decider is deterministic (zero LLM) ==="
if grep -E "anthropic|Anthropic|openai|OpenAI" src/cognition/role-selector/policy-decider.ts; then
  echo "[GATE 4/8] policy-decider deterministic ... FAIL"
  FAILED=$((FAILED + 1))
else
  echo "[GATE 4/8] policy-decider deterministic ... PASS"
  PASSED=$((PASSED + 1))
fi

echo "=== Gate 5/8: MULTI_CHANNEL flag registered in singleton ==="
if grep -q "MULTI_CHANNEL" src/config/feature-flags.ts; then
  echo "[GATE 5/8] MULTI_CHANNEL flag registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/8] MULTI_CHANNEL flag registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/8: decided_by CHECK does NOT include 'llm_classifier' ==="
DECIDED_BY_LINE=$(grep "decided_by IN" migrations/034_p6_role_selector_decisions.sql || true)
if [ -n "$DECIDED_BY_LINE" ] && ! echo "$DECIDED_BY_LINE" | grep -q "llm_classifier"; then
  echo "[GATE 6/8] decided_by CHECK excludes llm_classifier ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/8] decided_by CHECK excludes llm_classifier ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/8: seed migration preserves current Maia (free_with_trigger) ==="
if grep -q "free_with_trigger" migrations/035_p6_seed_default_channel_role_policy.sql; then
  echo "[GATE 7/8] seed preserves Maia (free_with_trigger) ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/8] seed preserves Maia (free_with_trigger) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/8: audit always invariant present in engine.ts ==="
if grep -q "ALWAYS record" src/cognition/role-selector/engine.ts; then
  echo "[GATE 8/8] audit always invariant ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/8] audit always invariant ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/8"
if [ "$FAILED" = "0" ]; then
  echo "All P6 acceptance gates green. Ready to tag p6-channel-role-policy-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
