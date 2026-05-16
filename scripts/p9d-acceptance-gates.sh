#!/bin/bash
# P9d Acceptance Gates — pure DSL evaluator (no DB needed).
# Run: bash scripts/p9d-acceptance-gates.sh
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/7: source files exist (5 modules + barrel) ==="
EXPECTED_FILES=(
  "src/governance/policy-dsl/types.ts"
  "src/governance/policy-dsl/constants.ts"
  "src/governance/policy-dsl/field-path.ts"
  "src/governance/policy-dsl/regex-cache.ts"
  "src/governance/policy-dsl/evaluator.ts"
  "src/governance/policy-dsl/validator.ts"
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
  echo "[GATE 1/7] source files exist ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/7] source files exist ($MISSING missing) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/7: vitest runs clean (unit + property + benchmark) ==="
if npx vitest run \
  tests/unit/policy-dsl-field-path.spec.ts \
  tests/unit/policy-dsl-regex-cache.spec.ts \
  tests/unit/policy-dsl-evaluator.spec.ts \
  tests/unit/policy-dsl-validator.spec.ts \
  tests/unit/policy-dsl-properties.spec.ts \
  tests/benchmark/policy-dsl.bench.spec.ts; then
  echo "[GATE 2/7] vitest runs clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/7] vitest runs clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/7: lint clean for policy-dsl files ==="
if npx eslint src/governance/policy-dsl/ tests/unit/policy-dsl-*.spec.ts tests/benchmark/policy-dsl.bench.spec.ts; then
  echo "[GATE 3/7] lint clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/7] lint clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/7: 10 operators registered in ALLOWED_OPERATORS ==="
COUNT=$(grep -c "'\(eq\|neq\|in\|not_in\|gt\|gte\|lt\|lte\|contains\|matches\)'," src/governance/policy-dsl/constants.ts || true)
if [ "$COUNT" = "10" ]; then
  echo "[GATE 4/7] 10 operators registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/7] 10 operators (got $COUNT, expected 10) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/7: ReDoS guard wired (safe-regex2 + length cap + cache) ==="
if grep -q "safe-regex2" src/governance/policy-dsl/regex-cache.ts \
  && grep -q "MAX_REGEX_INPUT_LENGTH" src/governance/policy-dsl/evaluator.ts \
  && grep -q "REGEX_CACHE_MAX" src/governance/policy-dsl/regex-cache.ts; then
  echo "[GATE 5/7] ReDoS guard wired ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/7] ReDoS guard wired ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/7: Architecture Lock — evaluator has zero side-effects ==="
# The evaluator must NOT import I/O modules (logger, db, fetch, etc).
if grep -E "import.*from.*'@/(db|lib/logger|gateway|workers)" src/governance/policy-dsl/*.ts; then
  echo "[GATE 6/7] Architecture Lock: evaluator imports I/O ... FAIL"
  FAILED=$((FAILED + 1))
else
  echo "[GATE 6/7] Architecture Lock: pure evaluator ... PASS"
  PASSED=$((PASSED + 1))
fi

echo "=== Gate 7/7: depth + length bounds documented in constants.ts ==="
if grep -q "MAX_PREDICATE_DEPTH = 16" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_FIELD_PATH_DEPTH = 16" src/governance/policy-dsl/constants.ts \
  && grep -q "MAX_REGEX_INPUT_LENGTH = 4096" src/governance/policy-dsl/constants.ts; then
  echo "[GATE 7/7] bounds documented ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/7] bounds documented ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/7"
if [ "$FAILED" = "0" ]; then
  echo "All P9d acceptance gates green."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
