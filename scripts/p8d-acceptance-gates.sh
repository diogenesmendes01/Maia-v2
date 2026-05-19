#!/bin/bash
# P8d Acceptance Gates — Identity Completion
# Run after P8d branch is merged + migration script executed.
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/6: LearnedVoiceModifier type + Zod export ==="
if [ -f "src/identity/learned-voice-modifier.ts" ] \
  && grep -q "export interface LearnedVoiceModifier" src/identity/learned-voice-modifier.ts \
  && grep -q "LearnedVoiceModifierSchema" src/identity/learned-voice-modifier.ts; then
  echo "[GATE 1/6] LearnedVoiceModifier type + schema ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/6] LearnedVoiceModifier type + schema ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/6: IdentitySlice builder exists ==="
# Post-merge: IdentitySlice type moved into the canonical
# src/runtime/context-packet/types.ts (extended with optional p8d fields).
# The standalone slice-builders/types/identity-slice.ts was removed on merge.
if [ -f "src/runtime/context-assembly/slice-builders/identity-slice-builder.ts" ] \
  && grep -q "buildIdentitySlice" src/runtime/context-assembly/slice-builders/identity-slice-builder.ts \
  && grep -q "identity_block" src/runtime/context-packet/types.ts; then
  echo "[GATE 2/6] IdentitySlice builder ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/6] IdentitySlice builder ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/6: papel_drift detector + DriftType.PAPEL_DRIFT registered ==="
if [ -f "src/cognition/drift/papel.ts" ] \
  && grep -q "papelDriftDetector" src/cognition/drift/index.ts \
  && grep -q "PAPEL_DRIFT.*'papel_drift'" src/types/enums.ts \
  && grep -q "case DriftType.PAPEL_DRIFT" src/cognition/drift/decision-engine.ts; then
  echo "[GATE 3/6] papel_drift detector + enum + decision case ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/6] papel_drift detector + enum + decision case ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/6: priorities extractor + migration script exist ==="
if grep -q "parsePrioritiesFromMarkdown" src/identity/proposal-generator.ts \
  && [ -f "scripts/p8d-migration-priorities.ts" ] \
  && grep -q "p8d_migrate.seeded" scripts/p8d-migration-priorities.ts; then
  echo "[GATE 4/6] priorities extractor + migration ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/6] priorities extractor + migration ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/6: write-path validation registered ==="
if grep -q "validateProfileBodyP8d" src/db/repositories.ts \
  && grep -q "LearnedVoiceModifierSchema" src/db/repositories.ts; then
  echo "[GATE 5/6] write-path validation ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/6] write-path validation ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/6: vitest suite (5 unit + 1 integration) ==="
if npx vitest run \
  tests/unit/learned-voice-modifier.spec.ts \
  tests/unit/identity-slice-builder.spec.ts \
  tests/unit/proposal-generator-priorities.spec.ts \
  tests/unit/drift-detector-papel.spec.ts \
  tests/unit/drift-decision-engine.spec.ts \
  tests/integration/p8d-identity-completion.spec.ts; then
  echo "[GATE 6/6] vitest suite ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/6] vitest suite ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "=== Summary: $PASSED passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
