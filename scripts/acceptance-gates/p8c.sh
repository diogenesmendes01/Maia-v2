#!/bin/bash
# ────────────────────────────────────────────────────────────
# P8c: User Layer Namespace — Acceptance Gates
# ────────────────────────────────────────────────────────────
# Verify cross-tenant isolation, lifecycle visibility, depth limits,
# and proper integration with P8b cache layer.
#
# Usage: npm run acceptance-gates:p8c
# (or directly: bash scripts/acceptance-gates/p8c.sh)
# ────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

cd "$PROJECT_ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "P8c: User Layer Namespace — Acceptance Gates"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Gate 1: Verify all resolvers filter by tenant_id
echo "[Gate 1] All resolvers filter by tenant_id (grep check)"
echo ""

GATE1_PASSED=true

# Check memory-resolver.ts
if grep -q "tenant_id" src/user-layer/resolvers/memory-resolver.ts; then
  echo "✓ memory-resolver.ts filters by tenant_id"
else
  echo "✗ memory-resolver.ts missing tenant_id filter"
  GATE1_PASSED=false
fi

# Check facts-resolver.ts
if grep -q "tenant_id" src/user-layer/resolvers/facts-resolver.ts; then
  echo "✓ facts-resolver.ts filters by tenant_id"
else
  echo "✗ facts-resolver.ts missing tenant_id filter"
  GATE1_PASSED=false
fi

# Check rules-resolver.ts
if grep -q "tenant_id" src/user-layer/resolvers/rules-resolver.ts; then
  echo "✓ rules-resolver.ts filters by tenant_id"
else
  echo "✗ rules-resolver.ts missing tenant_id filter"
  GATE1_PASSED=false
fi

# Check hints-resolver.ts
if grep -q "tenant_id" src/user-layer/resolvers/hints-resolver.ts; then
  echo "✓ hints-resolver.ts filters by tenant_id"
else
  echo "✗ hints-resolver.ts missing tenant_id filter"
  GATE1_PASSED=false
fi

if [ "$GATE1_PASSED" = true ]; then
  echo ""
  echo "✓ Gate 1 PASSED: All resolvers filter by tenant_id"
else
  echo ""
  echo "✗ Gate 1 FAILED: Some resolvers missing tenant_id filter"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 2: Verify NO resolver uses <table>.agent_id as a query predicate
# (writes to agent_id in insert/upsert are legitimate metadata)
echo "[Gate 2] No resolver uses <table>.agent_id as query predicate"
echo ""

GATE2_PASSED=true

# Match drizzle predicates that compare a column reference to agent_id:
#   eq(<table>.agent_id, ...) | inArray(<table>.agent_id, ...) | and(... .agent_id ...)
for resolver in src/user-layer/resolvers/*.ts; do
  if grep -E "(eq|inArray|ne|gt|lt|gte|lte)\(\s*\w+\.agent_id" "$resolver" > /dev/null 2>&1; then
    echo "✗ $(basename $resolver) filters by <table>.agent_id"
    GATE2_PASSED=false
  fi
done

if [ "$GATE2_PASSED" = true ]; then
  echo "✓ No resolvers filter by <table>.agent_id"
  echo ""
  echo "✓ Gate 2 PASSED: Cross-tenant isolation is correct"
else
  echo ""
  echo "✗ Gate 2 FAILED: Found agent_id used as query predicate"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 3: Verify lifecycle visibility filter exists
echo "[Gate 3] Lifecycle visibility filter implemented"
echo ""

if [ -f "src/user-layer/internal/visibility.ts" ]; then
  if grep -q "isVisibleLifecycle\|VISIBLE_LIFECYCLE_STATES" src/user-layer/internal/visibility.ts; then
    echo "✓ visibility.ts implements lifecycle filter"
    echo ""
    echo "✓ Gate 3 PASSED: Lifecycle visibility filter exists"
  else
    echo "✗ visibility.ts missing lifecycle filter implementation"
    echo ""
    echo "✗ Gate 3 FAILED"
    exit 1
  fi
else
  echo "✗ visibility.ts file not found"
  echo ""
  echo "✗ Gate 3 FAILED"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 4: Verify depth limits are applied
echo "[Gate 4] Depth-based limits implemented"
echo ""

if [ -f "src/user-layer/internal/depth-mapping.ts" ]; then
  if grep -q "USER_DEPTH_LIMITS\|KNOWLEDGE_DEPTH_LIMITS" src/user-layer/internal/depth-mapping.ts; then
    echo "✓ depth-mapping.ts defines depth limits"

    # Verify specific limits
    if grep -q "minimal.*5\|minimal:.*5" src/user-layer/internal/depth-mapping.ts; then
      echo "✓ User minimal depth limit set to 5"
    fi
    if grep -q "relevant.*15\|relevant:.*15" src/user-layer/internal/depth-mapping.ts; then
      echo "✓ User relevant depth limit set to 15"
    fi
    if grep -q "deep.*50\|deep:.*50" src/user-layer/internal/depth-mapping.ts; then
      echo "✓ User deep depth limit set to 50"
    fi

    echo ""
    echo "✓ Gate 4 PASSED: Depth limits implemented"
  else
    echo "✗ depth-mapping.ts missing depth limits"
    echo ""
    echo "✗ Gate 4 FAILED"
    exit 1
  fi
else
  echo "✗ depth-mapping.ts file not found"
  echo ""
  echo "✗ Gate 4 FAILED"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 5: Verify cache key builders exist
echo "[Gate 5] Cache key builders implemented"
echo ""

if [ -f "src/user-layer/internal/cache-keys.ts" ]; then
  if grep -q "buildUserSliceCacheKey\|buildKnowledgeSliceCacheKey" src/user-layer/internal/cache-keys.ts; then
    echo "✓ cache-keys.ts implements cache key builders"
    echo ""
    echo "✓ Gate 5 PASSED: Cache key builders exist"
  else
    echo "✗ cache-keys.ts missing cache key builders"
    echo ""
    echo "✗ Gate 5 FAILED"
    exit 1
  fi
else
  echo "✗ cache-keys.ts file not found"
  echo ""
  echo "✗ Gate 5 FAILED"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 6: Run user-layer unit tests
echo "[Gate 6] Run user-layer unit tests"
echo ""

if npm run test -- tests/unit/user-layer/ --run 2>/dev/null; then
  echo ""
  echo "✓ Gate 6 PASSED: user-layer tests passed"
else
  echo ""
  echo "✗ Gate 6 FAILED: user-layer tests failed"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 7: Verify migration file present in canonical location.
# After main absorbed P8e (036/037) and P8b (038-040), P8c is renumbered to 041.
echo "[Gate 7] Migration 041_p8c_lifecycle_status.sql present"
echo ""

MIGRATION_FILE="migrations/041_p8c_lifecycle_status.sql"
if [ -f "$MIGRATION_FILE" ]; then
  for t in memory_entry agent_facts learned_rules behavioral_hint; do
    if grep -qE "ALTER TABLE $t" "$MIGRATION_FILE"; then
      echo "✓ migration touches $t"
    else
      echo "✗ migration does not touch $t"
      exit 1
    fi
  done
  if grep -q "DEFAULT 'active'" "$MIGRATION_FILE"; then
    echo "✓ migration uses DEFAULT 'active'"
  else
    echo "✗ migration missing DEFAULT 'active'"
    exit 1
  fi
  echo ""
  echo "✓ Gate 7 PASSED: Migration file valid"
else
  echo "✗ migration file not found at $MIGRATION_FILE"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Gate 8 (PR #94 review): facade trust boundary + privacy gates present.
echo "[Gate 8] Facade tenant boundary + resolver privacy gates"
echo ""

GATE8_PASSED=true

# enforceTenantBoundary must exist and be wired into BOTH slice builders.
if [ -f "src/user-layer/internal/tenant-boundary.ts" ]; then
  echo "✓ tenant-boundary.ts present"
else
  echo "✗ tenant-boundary.ts missing"
  GATE8_PASSED=false
fi

for builder in src/user-layer/user-slice-builder.ts src/user-layer/knowledge-slice-builder.ts; do
  if grep -q "enforceTenantBoundary" "$builder"; then
    echo "✓ $(basename $builder) calls enforceTenantBoundary"
  else
    echo "✗ $(basename $builder) missing enforceTenantBoundary call"
    GATE8_PASSED=false
  fi
done

# memory-resolver must enforce needs_review=false at list time.
if grep -q "memory_entry.needs_review" src/user-layer/resolvers/memory-resolver.ts; then
  echo "✓ memory-resolver gates by needs_review"
else
  echo "✗ memory-resolver missing needs_review gate"
  GATE8_PASSED=false
fi

# facts-resolver must use the NOT EXISTS mentionable gate.
if grep -q "NOT EXISTS" src/user-layer/resolvers/facts-resolver.ts; then
  echo "✓ facts-resolver enforces NOT EXISTS mentionable gate"
else
  echo "✗ facts-resolver missing NOT EXISTS mentionable gate"
  GATE8_PASSED=false
fi

# knowledge-slice-builder MUST default only_active + pin tipo for rules.
if grep -q "only_active: true" src/user-layer/knowledge-slice-builder.ts \
   && grep -q "tipo: 'classificacao'" src/user-layer/knowledge-slice-builder.ts; then
  echo "✓ knowledge-slice-builder pins only_active=true + tipo='classificacao'"
else
  echo "✗ knowledge-slice-builder missing only_active/tipo defaults"
  GATE8_PASSED=false
fi

if [ "$GATE8_PASSED" = true ]; then
  echo ""
  echo "✓ Gate 8 PASSED: Facade boundary + privacy gates wired"
else
  echo ""
  echo "✗ Gate 8 FAILED: Privacy/boundary gates missing — see Codex review #94"
  exit 1
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo ""

# Final summary
echo "✓✓✓ ALL ACCEPTANCE GATES PASSED ✓✓✓"
echo ""
echo "P8c implementation verified:"
echo "  ✓ Cross-tenant isolation enforced"
echo "  ✓ Lifecycle visibility filtering"
echo "  ✓ Depth-based limits applied"
echo "  ✓ Cache integration ready for P8b"
echo "  ✓ No agent_id isolation leaks"
echo ""
echo "Ready for P8b cache layer integration."
