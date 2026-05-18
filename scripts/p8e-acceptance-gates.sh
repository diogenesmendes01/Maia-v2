#!/bin/bash
# P8e Acceptance Gates — run after DB up + P0-P7 + P4 + P8e migrations applied.
# Validates schema integrity, partial unique 'one active', resolver behavior,
# tenant isolation, cache hit-rate, feature flag, seed correctness, and the
# post-review #93 fixes (fail-closed resolver, cache invalidation wiring,
# dual-approval guard).
set -e

PASSED=0
FAILED=0
TOTAL_GATES=10

echo "=== Gate 1/10: migrations 036+037 present (UP + DOWN) + schema basics ==="
if [ -f "migrations/036_p8e_policy_rules.sql" ] \
  && [ -f "migrations/036_p8e_policy_rules_down.sql" ] \
  && [ -f "migrations/037_p8e_seed_default_hard_limits.sql" ] \
  && [ -f "migrations/037_p8e_seed_default_hard_limits_down.sql" ] \
  && grep -q "CREATE TABLE policy_rules" migrations/036_p8e_policy_rules.sql \
  && grep -q "DEFAULT 'proposed'" migrations/036_p8e_policy_rules.sql \
  && grep -q "idx_policy_rules_one_active_uq" migrations/036_p8e_policy_rules.sql \
  && grep -q "WHERE status = 'active'" migrations/036_p8e_policy_rules.sql; then
  echo "[GATE 1/10] migration files + DEFAULT 'proposed' + one-active uq ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/10] migration files / DEFAULT 'proposed' / one-active uq ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/10: seed migration inserts 5 hard_limit/lockdown_trigger policies ==="
if grep -q "no_refund_without_validation" migrations/037_p8e_seed_default_hard_limits.sql \
  && grep -q "lgpd_strict_no_pii_in_logs" migrations/037_p8e_seed_default_hard_limits.sql \
  && grep -q "no_action_outside_business_hours_high_risk" migrations/037_p8e_seed_default_hard_limits.sql \
  && grep -q "tenant_lockdown_blocks_all_writes" migrations/037_p8e_seed_default_hard_limits.sql \
  && grep -q "no_financial_advice_without_compliance_disclaimer" migrations/037_p8e_seed_default_hard_limits.sql \
  && grep -q "NOT EXISTS" migrations/037_p8e_seed_default_hard_limits.sql; then
  echo "[GATE 2/10] 5 seed descriptors + idempotency guard ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/10] 5 seed descriptors / idempotency ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/10: vitest runs clean for policy specs ==="
if npx vitest run \
  tests/unit/policy-cache.spec.ts \
  tests/unit/policy-descriptor-resolver.spec.ts \
  tests/unit/policy-rules-repo.spec.ts \
  tests/integration/p8e-policy-resolver.spec.ts; then
  echo "[GATE 3/10] vitest policy specs ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/10] vitest policy specs ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/10: control-plane/policy NOT imported from src/agent or src/cognition ==="
# Architecture Lock: resolver lives in Control Plane; agent / cognition must
# consume via slice builders (P8d) or PEPs (P9b/d), never directly.
LEAKS=$(grep -RIE "from '@/control-plane/policy" src/agent src/cognition 2>/dev/null || true)
if [ -z "$LEAKS" ]; then
  echo "[GATE 4/10] Architecture Lock: no direct imports from agent/cognition ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/10] Architecture Lock VIOLATED: $LEAKS"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/10: FEATURE_POLICY_RESOLVER_V1 registered + default OFF ==="
if grep -q "POLICY_RESOLVER_V1" src/types/enums.ts \
  && grep -q "FEATURE_POLICY_RESOLVER_V1" src/config/env.ts \
  && grep -q "POLICY_RESOLVER_V1" src/config/feature-flags.ts \
  && grep -A2 "FEATURE_POLICY_RESOLVER_V1" src/config/env.ts | grep -q "'false'"; then
  echo "[GATE 5/10] feature flag registered + default off ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/10] feature flag missing or default not off ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/10: rule_body treated as opaque (no DSL evaluator in P8e) ==="
# Spec: P8e does NOT evaluate rule_body. P9d will. Verify no predicate/effect
# evaluation logic in the policy module.
if grep -RIE "evaluate.*predicate|predicate.*evaluate|PolicyPredicate.evaluate" src/control-plane/policy/ 2>/dev/null; then
  echo "[GATE 6/10] rule_body opacity VIOLATED — predicate evaluator found in P8e"
  FAILED=$((FAILED + 1))
else
  echo "[GATE 6/10] rule_body treated as opaque (no DSL evaluator) ... PASS"
  PASSED=$((PASSED + 1))
fi

echo "=== Gate 7/10: 9 repo methods present (read + write side) ==="
EXPECTED_METHODS="findActiveByDescriptor listActiveForTenant listVersions getById propose activate deprecate rollback nextVersion"
MISSING=""
for m in $EXPECTED_METHODS; do
  if ! grep -q "  async ${m}\b\|^  ${m}(" src/control-plane/policy/policy-rules-repo.ts; then
    MISSING="$MISSING $m"
  fi
done
if [ -z "$MISSING" ]; then
  echo "[GATE 7/10] all 9 repo methods present ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/10] missing methods:$MISSING"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/10: fail-closed resolver contract (RESOLVER_FAILURE_DEFAULT='block') ==="
# Codex review #93: resolver must distinguish db_error from not_found and
# pin a 'block' default. Check both the constant and the typed failure
# reason wired into the resolver.
if grep -q "RESOLVER_FAILURE_DEFAULT = 'block' as const" src/control-plane/policy/types.ts \
  && grep -q "reason: 'db_error'" src/control-plane/policy/policy-descriptor-resolver.ts \
  && grep -q "policy_resolver.db_error_fail_closed" src/control-plane/policy/policy-descriptor-resolver.ts; then
  echo "[GATE 8/10] resolver fail-closed contract present ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/10] resolver fail-closed contract missing ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 9/10: cache invalidation subscriber wired at startup ==="
# Codex review #93: subscriber was defined but never called. Verify
# src/index.ts wires startPolicyCacheInvalidationSubscriber gated on the
# feature flag.
if grep -q "startPolicyCacheInvalidationSubscriber" src/index.ts \
  && grep -q "POLICY_RESOLVER_V1" src/index.ts; then
  echo "[GATE 9/10] cache invalidation subscriber wired ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 9/10] cache invalidation subscriber NOT wired ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 10/10: structured DualApprovalEvidence + DB-level approval CHECK ==="
# Codex review #93: hard-limit guard previously accepted any truthy object.
# Now it requires a structured shape (2 distinct approvers) and the DB
# enforces approved_by NOT NULL for status='active' as defense in depth.
# Also: lockdown_trigger now under the same dual-approval guard.
if grep -q "isValidDualApprovalEvidence" src/control-plane/policy/policy-rules-repo.ts \
  && grep -q "ACTIVATION_REQUIRES_DUAL_APPROVAL" src/control-plane/policy/policy-rules-repo.ts \
  && grep -q "'hard_limit'" src/control-plane/policy/policy-rules-repo.ts \
  && grep -q "'lockdown_trigger'" src/control-plane/policy/policy-rules-repo.ts \
  && grep -q "policy_rules_active_requires_approval" migrations/036_p8e_policy_rules.sql; then
  echo "[GATE 10/10] dual-approval guard hardened + DB approval CHECK ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 10/10] dual-approval guard / DB CHECK missing ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/$TOTAL_GATES"
if [ "$FAILED" = "0" ]; then
  echo "All P8e acceptance gates green. Ready to tag p8e-policy-descriptor-resolver-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
