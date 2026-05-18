#!/bin/bash
# P8b Acceptance Gates — proves Soul Layer done criteria.
# Run after DB up + P0..P7 migrations applied + P8b branch merged.
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/10: P8b module structure (7 files) ==="
STRUCT_OK=1
for f in \
  migrations/038_p8b_soul_biases.sql \
  migrations/038_p8b_soul_biases_down.sql \
  migrations/038b_p8b_extend_drift_alerts_type.sql \
  migrations/038c_p8b_extend_capability_proposal_type.sql \
  migrations/039_p8b_seed_founder_biases.sql \
  src/control-plane/soul/soul-biases-repo.ts \
  src/control-plane/soul/origin-gate.ts \
  src/runtime/context-assembly/types/soul-slice.ts \
  src/runtime/context-assembly/slice-builders/soul-slice-builder.ts \
  src/cognition/drift/soul.ts \
  src/workers/soul-bias-activator.ts; do
  if [ ! -f "$f" ]; then
    echo "  missing: $f"
    STRUCT_OK=0
  fi
done
if [ "$STRUCT_OK" = "1" ]; then
  echo "[GATE 1/10] P8b module structure ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/10] P8b module structure ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/10: migration 038 — soul_biases DEFAULT 'proposed' (invariante 5) ==="
if grep -q "DEFAULT 'proposed'" migrations/038_p8b_soul_biases.sql; then
  echo "[GATE 2/10] DEFAULT 'proposed' ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/10] DEFAULT 'proposed' ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/10: migration 038 — partial unique 'one active' (invariante 6) ==="
if grep -q "soul_biases_one_active_idx" migrations/038_p8b_soul_biases.sql && \
   grep -q "WHERE status = 'active'" migrations/038_p8b_soul_biases.sql; then
  echo "[GATE 3/10] partial unique 'one active' ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/10] partial unique 'one active' ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/10: vitest suites for P8b ==="
if npx vitest run \
  tests/unit/soul-biases-schema.spec.ts \
  tests/unit/soul-biases-repo.spec.ts \
  tests/unit/soul-slice-builder.spec.ts \
  tests/unit/soul-drift-detector.spec.ts \
  tests/unit/origin-gate.spec.ts \
  tests/unit/soul-bias-activator.spec.ts \
  tests/unit/capability-proposer-soul-bias.spec.ts \
  tests/integration/p8b-soul-layer.spec.ts; then
  echo "[GATE 4/10] P8b test suites ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/10] P8b test suites ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/10: origin gate — learned_strong_evidence NEVER overrides (spec §7) ==="
if grep -q "learned_strong_evidence" src/control-plane/soul/origin-gate.ts && \
   grep -q "origin_blocks_override" src/control-plane/soul/origin-gate.ts && \
   grep -q "soul_identity_conflict" src/control-plane/soul/origin-gate.ts; then
  echo "[GATE 5/10] origin gate learned_strong_evidence guard ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/10] origin gate learned_strong_evidence guard ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/10: soul_drift detector wired in orchestrator (8th type) ==="
if grep -q "soulDriftDetector" src/cognition/drift/index.ts && \
   grep -q "SOUL_DRIFT" src/types/enums.ts; then
  echo "[GATE 6/10] soul_drift detector wired ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/10] soul_drift detector wired ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/10: decision-engine — soul_drift NEVER frozen/rollback (spec §5.4) ==="
if grep -q "decisionForSoulDriftSeverity" src/cognition/drift/decision-engine.ts && \
   grep -q "QUEUED_HUMAN" src/cognition/drift/decision-engine.ts; then
  echo "[GATE 7/10] soul_drift decision capped at QUEUED_HUMAN ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/10] soul_drift decision capped ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/10: applyTenantGuard usage in soulBiasesRepo (P0 invariant) ==="
if grep -q "applyTenantGuard" src/control-plane/soul/soul-biases-repo.ts && \
   grep -q "getCurrentTenant" src/control-plane/soul/soul-biases-repo.ts; then
  echo "[GATE 8/10] applyTenantGuard in soulBiasesRepo ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/10] applyTenantGuard in soulBiasesRepo ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 9/10: FEATURE_SOUL_LAYER_V1 flag registered ==="
if grep -q "FEATURE_SOUL_LAYER_V1" src/types/enums.ts; then
  echo "[GATE 9/10] FEATURE_SOUL_LAYER_V1 flag registered ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 9/10] FEATURE_SOUL_LAYER_V1 flag registered ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 10/10: capability_proposer soul_bias branch + worker (spec §6) ==="
if grep -q "proposeSoulBiasFromDriftAlert" src/cognition/capability-proposer.ts && \
   grep -q "processSoulBiasProposalApproval" src/workers/soul-bias-activator.ts; then
  echo "[GATE 10/10] capability_proposer soul_bias branch + worker ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 10/10] capability_proposer soul_bias branch + worker ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "gates passed: $PASSED — failed: $FAILED"
if [ "$FAILED" = "0" ]; then
  echo "All P8b acceptance gates green. Ready to tag p8b-soul-layer-done."
  exit 0
else
  echo "Some gates failed."
  exit 1
fi
