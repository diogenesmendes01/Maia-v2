#!/bin/bash
# P4 Acceptance Gates — run after DB up + P0+P1+P2+P3a+P3b+P3c+P4 migrations applied
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/7: migrations 025 and 026 (UP + DOWN) ==="
if [ -f "migrations/025_p4_agent_operational_profile_versions.sql" ] \
  && [ -f "migrations/025_p4_agent_operational_profile_versions_down.sql" ] \
  && [ -f "migrations/026_p4_agent_drift_alerts.sql" ] \
  && [ -f "migrations/026_p4_agent_drift_alerts_down.sql" ] \
  && grep -q "CREATE TABLE agent_operational_profile_versions" migrations/025_p4_agent_operational_profile_versions.sql \
  && grep -q "CREATE TABLE agent_drift_alerts" migrations/026_p4_agent_drift_alerts.sql; then
  echo "[GATE 1/7] schema/migration check ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/7] schema/migration check ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/7: vitest runs clean ==="
if npx vitest run \
  tests/unit/enums-p4.spec.ts \
  tests/unit/db-schema-p4.spec.ts \
  tests/unit/operational-profile-versions-repo.spec.ts \
  tests/unit/drift-alerts-repo.spec.ts \
  tests/unit/identity-proposal-generator.spec.ts \
  tests/unit/identity-profile-renderer.spec.ts \
  tests/unit/identity-prompt-builder-flag.spec.ts \
  tests/unit/drift-detector-tom.spec.ts \
  tests/unit/drift-detector-valores.spec.ts \
  tests/unit/drift-detector-confianca.spec.ts \
  tests/unit/drift-detector-vies.spec.ts \
  tests/unit/drift-detector-escopo.spec.ts \
  tests/unit/drift-detector-linguagem.spec.ts \
  tests/unit/drift-detector-procedimento.spec.ts \
  tests/unit/drift-decision-engine.spec.ts \
  tests/unit/drift-monitor.spec.ts \
  tests/integration/p4-operational-identity.spec.ts; then
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

echo "=== Gate 4/7: 7 drift detectors exist ==="
COUNT=$(ls src/cognition/drift/{tom,valores,confianca,vies,escopo,linguagem,procedimento}.ts 2>/dev/null | wc -l)
if [ "$COUNT" = "7" ]; then
  echo "[GATE 4/7] 7 drift detectors exist ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/7] 7 drift detectors exist (got $COUNT, expected 7) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/7: drift_monitor worker registered ==="
if grep -q "drift_monitor" src/workers/index.ts; then
  echo "[GATE 5/7] drift_monitor worker registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/7] drift_monitor worker registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/7: OPERATIONAL_PROFILE_V2 flag registered in singleton ==="
if grep -q "OPERATIONAL_PROFILE_V2" src/config/feature-flags.ts; then
  echo "[GATE 6/7] OPERATIONAL_PROFILE_V2 flag registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/7] OPERATIONAL_PROFILE_V2 flag registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

# Issue #525 moved the identity READ (and this guard) out of prompt-builder.ts
# into the turn-context loader; prompt-builder.ts is now a pure renderer.
echo "=== Gate 7/7: turn-context loader enforces status === 'active' ==="
if grep -q "status === 'active'" src/agent/turn-context/loader.ts; then
  echo "[GATE 7/7] turn-context loader enforces status === 'active' ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/7] turn-context loader enforces status === 'active' ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/7"
if [ "$FAILED" = "0" ]; then
  echo "All P4 acceptance gates green. Ready to tag p4-operational-identity-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
