#!/bin/bash
# P9d Acceptance Gates — pure DSL evaluator (no DB needed).
# Run: bash scripts/p9d-acceptance-gates.sh
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/9: source files exist (6 modules + barrel) ==="
EXPECTED_FILES=(
  "src/governance/policy-dsl/types.ts"
  "src/governance/policy-dsl/constants.ts"
  "src/governance/policy-dsl/field-path.ts"
  "src/governance/policy-dsl/regex-cache.ts"
  "src/governance/policy-dsl/evaluator.ts"
  "src/governance/policy-dsl/validator.ts"
  "src/governance/policy-dsl/enforcement.ts"
  "src/governance/policy-dsl/index.ts"
)
MISSING=0
for f in "${EXPECTED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "  missing: $f"
    MISSING=$((MISSING + 1))
  fi
done
if [ "$MISSING" = "0" ]; then
  echo "[GATE 1/9] source files exist ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/9] source files exist ($MISSING missing) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/9: vitest runs clean (unit + property + enforcement + benchmark) ==="
if npx vitest run \
  tests/unit/policy-dsl-field-path.spec.ts \
  tests/unit/policy-dsl-regex-cache.spec.ts \
  tests/unit/policy-dsl-evaluator.spec.ts \
  tests/unit/policy-dsl-validator.spec.ts \
  tests/unit/policy-dsl-enforcement.spec.ts \
  tests/unit/policy-dsl-properties.spec.ts \
  tests/benchmark/policy-dsl.bench.spec.ts; then
  echo "[GATE 2/9] vitest runs clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/9] vitest runs clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/9: lint clean for policy-dsl files ==="
if npx eslint src/governance/policy-dsl/ tests/unit/policy-dsl-*.spec.ts tests/benchmark/policy-dsl.bench.spec.ts; then
  echo "[GATE 3/9] lint clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/9] lint clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/9: 10 operators registered in ALLOWED_OPERATORS ==="
COUNT=$(grep -c "'\(eq\|neq\|in\|not_in\|gt\|gte\|lt\|lte\|contains\|matches\)'," src/governance/policy-dsl/constants.ts || true)
if [ "$COUNT" = "10" ]; then
  echo "[GATE 4/9] 10 operators registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/9] 10 operators (got $COUNT, expected 10) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/9: ReDoS guard wired (safe-regex2 + length cap + cache) ==="
if grep -q "safe-regex2" src/governance/policy-dsl/regex-cache.ts \
  && grep -q "MAX_REGEX_INPUT_LENGTH" src/governance/policy-dsl/evaluator.ts \
  && grep -q "REGEX_CACHE_MAX" src/governance/policy-dsl/regex-cache.ts; then
  echo "[GATE 5/9] ReDoS guard wired ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/9] ReDoS guard wired ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/9: Architecture Lock — evaluator has zero side-effects ==="
# The evaluator must NOT import I/O modules (logger, db, fetch, etc).
if grep -E "import.*from.*'@/(db|lib/logger|gateway|workers)" src/governance/policy-dsl/*.ts; then
  echo "[GATE 6/9] Architecture Lock: evaluator imports I/O ... FAIL"
  FAILED=$((FAILED + 1))
else
  echo "[GATE 6/9] Architecture Lock: pure evaluator ... PASS"
  PASSED=$((PASSED + 1))
fi

echo "=== Gate 7/9: depth + length + fan-out + total-nodes bounds documented ==="
if grep -q "MAX_PREDICATE_DEPTH = 16" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_FIELD_PATH_DEPTH = 16" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_REGEX_INPUT_LENGTH = 4096" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_BRANCH_FANOUT" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_TOTAL_PREDICATE_NODES" src/governance/policy-dsl/constants.ts; then
  echo "[GATE 7/9] all bounds documented ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/9] bounds documented ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/9: Tri-state PolicyOutcome present (Codex review #98) ==="
# Verify PolicyOutcome union exists with all 4 variants + that the evaluator
# emits all 4 outcomes (Architecture Lock).
if grep -q "'matched'" src/governance/policy-dsl/types.ts \
  && grep -q "'not_matched'" src/governance/policy-dsl/types.ts \
  && grep -q "'not_applicable'" src/governance/policy-dsl/types.ts \
  && grep -q "'evaluation_error'" src/governance/policy-dsl/types.ts \
  && grep -q "'not_applicable'" src/governance/policy-dsl/evaluator.ts \
  && grep -q "'evaluation_error'" src/governance/policy-dsl/evaluator.ts; then
  echo "[GATE 8/9] tri-state outcome wired ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/9] tri-state outcome wired ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 9/9: Architecture Lock — enforce() maps evaluation_error → block ==="
# The enforce() helper must be present + the property test must cover the
# 'evaluation_error → block' invariant.
if [ -f "src/governance/policy-dsl/enforcement.ts" ] \
  && grep -q "export function enforce" src/governance/policy-dsl/enforcement.ts \
  && grep -q "evaluation_error MUST always block" tests/unit/policy-dsl-enforcement.spec.ts; then
  echo "[GATE 9/9] enforce() architecture lock ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 9/9] enforce() architecture lock ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/9"
if [ "$FAILED" = "0" ]; then
  echo "All P9d acceptance gates green."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
