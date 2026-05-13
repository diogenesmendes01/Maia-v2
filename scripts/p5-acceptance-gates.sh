#!/bin/bash
# P5 Acceptance Gates — run after DB up + P0+P1+P2+P3+P4+P5 migrations applied
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/7: migrations 027+028+029+030 (UP + DOWN) ==="
if [ -f "migrations/027_p5_gap_escalation_rules.sql" ] \
  && [ -f "migrations/027_p5_gap_escalation_rules_down.sql" ] \
  && [ -f "migrations/028_p5_capability_proposals.sql" ] \
  && [ -f "migrations/028_p5_capability_proposals_down.sql" ] \
  && [ -f "migrations/029_p5_capability_test_results.sql" ] \
  && [ -f "migrations/029_p5_capability_test_results_down.sql" ] \
  && [ -f "migrations/030_p5_extend_capability_gap_tipo.sql" ] \
  && [ -f "migrations/030_p5_extend_capability_gap_tipo_down.sql" ] \
  && grep -q "CREATE TABLE gap_escalation_rules" migrations/027_p5_gap_escalation_rules.sql \
  && grep -q "CREATE TABLE capability_proposals" migrations/028_p5_capability_proposals.sql \
  && grep -q "CREATE TABLE capability_test_results" migrations/029_p5_capability_test_results.sql \
  && grep -q "ALTER TABLE agent_capability_gaps DROP CONSTRAINT" migrations/030_p5_extend_capability_gap_tipo.sql; then
  echo "[GATE 1/7] schema/migration check ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/7] schema/migration check ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/7: vitest runs clean ==="
if npx vitest run \
  tests/unit/enums-p5.spec.ts \
  tests/unit/db-schema-p5.spec.ts \
  tests/unit/capability-proposals-repo.spec.ts \
  tests/unit/capability-test-results-repo.spec.ts \
  tests/unit/gap-escalation-engine.spec.ts \
  tests/unit/capability-proposer.spec.ts \
  tests/unit/capability-test-runner.spec.ts \
  tests/unit/capability-revert.spec.ts \
  tests/unit/gap-escalation-monitor.spec.ts \
  tests/unit/notification-adapter.spec.ts \
  tests/unit/prompt-builder-gap-mention.spec.ts \
  tests/integration/p5-dialogical-acquisition.spec.ts; then
  echo "[GATE 2/7] vitest runs clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/7] vitest runs clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/7: typecheck ==="
if npx tsc --noEmit; then
  echo "[GATE 3/7] typecheck ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/7] typecheck ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/7: gap-escalation engine is deterministic (zero LLM) ==="
if grep -E "anthropic|Anthropic|openai|OpenAI" src/cognition/gap-escalation/engine.ts; then
  echo "[GATE 4/7] gap-escalation engine deterministic ... FAIL"
  FAILED=$((FAILED + 1))
else
  echo "[GATE 4/7] gap-escalation engine deterministic ... PASS"
  PASSED=$((PASSED + 1))
fi

echo "=== Gate 5/7: gap_escalation_monitor worker registered ==="
if grep -q "gap_escalation_monitor" src/workers/index.ts; then
  echo "[GATE 5/7] gap_escalation_monitor worker registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/7] gap_escalation_monitor worker registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/7: DIALOGICAL_ACQUISITION flag registered in singleton ==="
if grep -q "DIALOGICAL_ACQUISITION" src/config/feature-flags.ts; then
  echo "[GATE 6/7] DIALOGICAL_ACQUISITION flag registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/7] DIALOGICAL_ACQUISITION flag registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/7: notification-adapter no-notify on GapLevel.SILENT ==="
if grep -q "GapLevel.SILENT" src/agent/notification-adapter.ts; then
  echo "[GATE 7/7] notification-adapter handles GapLevel.SILENT ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/7] notification-adapter handles GapLevel.SILENT ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/7"
if [ "$FAILED" = "0" ]; then
  echo "All P5 acceptance gates green. Ready to tag p5-dialogical-acquisition-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
