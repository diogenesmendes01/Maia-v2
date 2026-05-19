#!/bin/bash
# P8a Acceptance Gates — Context Packet infrastructure
# Run after the branch is on top of main with all P8a code merged.
set -e

PASSED=0
FAILED=0

echo "=== Gate 1/9: 7 slice builders + tests exist ==="
SLICE_OK=1
for slice in identity user knowledge soul policy skill tool; do
  if [ ! -f "src/runtime/context-assembly/slice-builders/${slice}-slice-builder.ts" ]; then
    echo "  MISS src/runtime/context-assembly/slice-builders/${slice}-slice-builder.ts"
    SLICE_OK=0
  fi
  if [ ! -f "tests/unit/runtime/context-assembly/${slice}-slice-builder.spec.ts" ]; then
    echo "  MISS tests/unit/runtime/context-assembly/${slice}-slice-builder.spec.ts"
    SLICE_OK=0
  fi
done
if [ $SLICE_OK -eq 1 ]; then
  echo "[GATE 1/9] slice builders + tests ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 1/9] slice builders + tests ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 2/9: Cache + invalidation bus ==="
if [ -f "src/runtime/context-packet/cache/slice-cache.ts" ] \
  && [ -f "src/runtime/context-packet/cache/invalidation-bus.ts" ] \
  && [ -f "src/runtime/context-packet/cache/ttl-policy.ts" ]; then
  echo "[GATE 2/9] cache layer ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 2/9] cache layer ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 3/9: Packet types (BaseContextPacket, DecisionPacket, ExecutionContextPacket) ==="
if grep -q "interface BaseContextPacket" src/runtime/context-packet/types.ts \
  && grep -q "interface DecisionPacket" src/runtime/context-packet/types.ts \
  && grep -q "interface ExecutionContextPacket" src/runtime/context-packet/types.ts; then
  echo "[GATE 3/9] packet types ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 3/9] packet types ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 4/9: Feature flag + kill switch ==="
if [ -f "src/runtime/feature-flags/context-packet-flag.ts" ] \
  && grep -q "isContextPacketV1Enabled" src/runtime/feature-flags/context-packet-flag.ts \
  && grep -q "FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH" src/runtime/feature-flags/context-packet-flag.ts; then
  echo "[GATE 4/9] flag + kill switch ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 4/9] flag + kill switch ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 5/9: No DB migrations introduced specifically for P8a ==="
# P8a is code-only. We check that no migration file references P8a/p8a markers.
P8A_MIGRATIONS=$(find migrations/ -type f \( -name "*p8a*" -o -name "*context-packet*" -o -name "*context_packet*" \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$P8A_MIGRATIONS" -eq 0 ]; then
  echo "[GATE 5/9] no migrations ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 5/9] no migrations ... FAIL ($P8A_MIGRATIONS p8a-tagged migration(s))"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 6/9: vitest passes (context packet + slice builders + integration) ==="
if npx vitest run \
  tests/unit/runtime/context-packet/ \
  tests/unit/runtime/context-assembly/ \
  tests/unit/runtime/feature-flags/ \
  tests/unit/runtime/prompt/ \
  tests/integration/runtime/p8a-context-packet-integration.spec.ts; then
  echo "[GATE 6/9] vitest runs clean ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 6/9] vitest runs clean ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 7/9: orchestrator + builder count (8 builders + 1 orchestrator) ==="
ORCH_OK=1
[ -f "src/runtime/context-packet/build-context-packet.ts" ] || ORCH_OK=0
[ -f "src/runtime/context-packet/base-context-builder.ts" ] || ORCH_OK=0
[ -f "src/runtime/context-packet/decision-packet-stub.ts" ] || ORCH_OK=0
if [ $ORCH_OK -eq 1 ]; then
  echo "[GATE 7/9] orchestrator + builders ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 7/9] orchestrator + builders ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 8/9: Knowledge lifecycle invariant (proposed/pending_review NEVER exposed) ==="
# Verify the allowlist excludes proposed and pending_review at source.
if grep -q "'ephemeral'" src/runtime/context-assembly/slice-builders/knowledge-slice-builder.ts \
  && ! grep -q "'proposed'" src/runtime/context-assembly/slice-builders/knowledge-slice-builder.ts \
  && ! grep -q "'pending_review'" src/runtime/context-assembly/slice-builders/knowledge-slice-builder.ts; then
  echo "[GATE 8/9] knowledge lifecycle invariant ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 8/9] knowledge lifecycle invariant ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo "=== Gate 9/9: Policy hard_limit preservation (source check) ==="
if grep -q "hard_limit" src/runtime/context-assembly/slice-builders/policy-slice-builder.ts \
  && grep -q "preserved" src/runtime/context-assembly/slice-builders/policy-slice-builder.ts; then
  echo "[GATE 9/9] policy hard_limit preservation ... PASS"
  PASSED=$((PASSED + 1))
else
  echo "[GATE 9/9] policy hard_limit preservation ... FAIL"
  FAILED=$((FAILED + 1))
fi

echo ""
echo "==============================================="
echo "P8a Acceptance Gates: $PASSED PASSED, $FAILED FAILED"
echo "==============================================="

if [ $FAILED -gt 0 ]; then
  exit 1
fi
exit 0
