#!/bin/bash
# P4 Acceptance Gates — run after DB up + P0+P1+P2+P3a+P3b+P3c+P4 migrations applied
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/8: migrations 025 and 026 (UP + DOWN) ==="
if [ -f "migrations/025_p4_agent_operational_profile_versions.sql" ] \
  && [ -f "migrations/025_p4_agent_operational_profile_versions_down.sql" ] \
  && [ -f "migrations/026_p4_agent_drift_alerts.sql" ] \
  && [ -f "migrations/026_p4_agent_drift_alerts_down.sql" ] \
  && grep -q "CREATE TABLE agent_operational_profile_versions" migrations/025_p4_agent_operational_profile_versions.sql \
  && grep -q "CREATE TABLE agent_drift_alerts" migrations/026_p4_agent_drift_alerts.sql; then
  echo "[GATE 1/8] schema/migration check ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/8] schema/migration check ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/8: vitest runs clean ==="
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

echo "=== Gate 4/8: 7 drift detectors exist ==="
COUNT=$(ls src/cognition/drift/{tom,valores,confianca,vies,escopo,linguagem,procedimento}.ts 2>/dev/null | wc -l)
if [ "$COUNT" = "7" ]; then
  echo "[GATE 4/8] 7 drift detectors exist ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/8] 7 drift detectors exist (got $COUNT, expected 7) ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/8: drift_monitor worker registered ==="
if grep -q "drift_monitor" src/workers/index.ts; then
  echo "[GATE 5/8] drift_monitor worker registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/8] drift_monitor worker registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/8: OPERATIONAL_PROFILE_V2 flag registered in singleton ==="
if grep -q "OPERATIONAL_PROFILE_V2" src/config/feature-flags.ts; then
  echo "[GATE 6/8] OPERATIONAL_PROFILE_V2 flag registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/8] OPERATIONAL_PROFILE_V2 flag registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/8: prompt-builder enforces status === 'active' ==="
if grep -q "status === 'active'" src/agent/prompt-builder.ts; then
  echo "[GATE 7/8] prompt-builder enforces status === 'active' ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/8] prompt-builder enforces status === 'active' ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/8: legacy 4-column shape removed ==="
LEGACY_HITS_SCHEMA=$(grep -cE "^\s+(core_immutable|episodic_temp|growth_backlog):\s" src/db/schema.ts || true)
LEGACY_HITS_MIGRATION=$(grep -cE "^\s+(core_immutable|episodic_temp|growth_backlog)\s+JSONB" migrations/025_p4_agent_operational_profile_versions.sql || true)
PROFILE_BODY_PRESENT=$(grep -c "profile_body" migrations/025_p4_agent_operational_profile_versions.sql || true)
SCHEMA_VERSION_PRESENT=$(grep -c "v3.1.1-2026-05-15" migrations/025_p4_agent_operational_profile_versions.sql || true)
PROFILEBODY_TYPE_PRESENT=$(grep -c "interface ProfileBody" src/db/schema.ts || true)

if [ "$LEGACY_HITS_SCHEMA" = "0" ] \
  && [ "$LEGACY_HITS_MIGRATION" = "0" ] \
  && [ "$PROFILE_BODY_PRESENT" != "0" ] \
  && [ "$SCHEMA_VERSION_PRESENT" != "0" ] \
  && [ "$PROFILEBODY_TYPE_PRESENT" != "0" ]; then
  echo "[GATE 8/8] v3.1.1 schema invariants ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/8] v3.1.1 schema invariants ... FAIL"
  echo "  legacy hits in schema.ts: $LEGACY_HITS_SCHEMA (expect 0)"
  echo "  legacy hits in migration: $LEGACY_HITS_MIGRATION (expect 0)"
  echo "  profile_body in migration: $PROFILE_BODY_PRESENT (expect >0)"
  echo "  v3.1.1-2026-05-15 literal: $SCHEMA_VERSION_PRESENT (expect >0)"
  echo "  interface ProfileBody: $PROFILEBODY_TYPE_PRESENT (expect >0)"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED/8"
if [ "$FAILED" = "0" ]; then
  echo "All P4 acceptance gates green. Ready to tag p4-operational-identity-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
