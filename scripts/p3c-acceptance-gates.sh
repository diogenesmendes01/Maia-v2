#!/bin/bash
# P3c Acceptance Gates — run after DB up + P0+P1+P2+P3a+P3b+P3c migrations applied
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/7: migrations 023 and 024 (UP + DOWN) ==="
if [ -f "migrations/023_p3c_procedure_tests.sql" ] \
  && [ -f "migrations/023_p3c_procedure_tests_down.sql" ] \
  && [ -f "migrations/024_p3c_procedure_metrics.sql" ] \
  && [ -f "migrations/024_p3c_procedure_metrics_down.sql" ] \
  && grep -q "CREATE TABLE procedure_tests" migrations/023_p3c_procedure_tests.sql \
  && grep -q "CREATE MATERIALIZED VIEW procedure_metrics" migrations/024_p3c_procedure_metrics.sql; then
  echo "[GATE 1/7] schema/migration check ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/7] schema/migration check ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/7: vitest runs clean ==="
if npx vitest run \
  tests/unit/db-schema-p3c.spec.ts \
  tests/unit/procedure-tests-repo.spec.ts \
  tests/unit/step-evaluator-llm-judge.spec.ts \
  tests/unit/step-evaluator-user-signal.spec.ts \
  tests/unit/step-evaluator-human-confirmed.spec.ts \
  tests/unit/procedure-engine-human-confirmation.spec.ts \
  tests/unit/procedure-test-runner.spec.ts \
  tests/unit/procedure-status-test-gate.spec.ts \
  tests/unit/procedure-execution-reaper.spec.ts \
  tests/unit/procedure-metrics-refresh.spec.ts \
  tests/integration/p3c-procedure-governance.spec.ts; then
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

echo "=== Gate 4/7: all 5 criterion types in step-evaluator ==="
COUNT=$(grep -cE "type === '(machine_check|tool_result|llm_judge|user_signal|human_confirmed)'" src/cognition/step-evaluator.ts)
if [ "$COUNT" = "5" ]; then
  echo "[GATE 4/7] all 5 criterion types in step-evaluator ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/7] all 5 criterion types in step-evaluator (got $COUNT, expected 5) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/7: reaper worker registered ==="
if grep -q "procedure_execution_reaper" src/workers/index.ts; then
  echo "[GATE 5/7] reaper worker registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/7] reaper worker registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/7: metrics refresh worker registered ==="
if grep -q "procedure_metrics_refresh" src/workers/index.ts; then
  echo "[GATE 6/7] metrics refresh worker registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/7] metrics refresh worker registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/7: step evaluator is async ==="
if grep -qE "export.*async function evaluateCurrentStep" src/cognition/step-evaluator.ts; then
  echo "[GATE 7/7] step evaluator is async ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/7] step evaluator is async ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/7"
if [ "$FAILED" = "0" ]; then
  echo "All P3c acceptance gates green. Ready to tag p3c-procedure-governance-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
