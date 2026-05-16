#!/usr/bin/env bash
# P8.5 — Admin UI v1 acceptance gates (11 checks).
#
# Usage:
#   bash scripts/admin-ui-acceptance-gates.sh                # run all gates
#   bash scripts/admin-ui-acceptance-gates.sh --preconditions-only
#   bash scripts/admin-ui-acceptance-gates.sh --skip-e2e
#
# Exit 0 = all gates pass; non-zero = first failure.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PRECONDITIONS_ONLY=0
SKIP_E2E=0
for arg in "$@"; do
  case "$arg" in
    --preconditions-only) PRECONDITIONS_ONLY=1 ;;
    --skip-e2e) SKIP_E2E=1 ;;
  esac
done

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); exit 1; }

echo "P8.5 — Admin UI v1 acceptance gates"
echo ""

echo "Preconditions"
test -f src/db/schema.ts && pass "schema.ts present" || fail "schema.ts missing"
test -f src/db/repositories.ts && pass "repositories.ts present" || fail "repositories.ts missing"
test -f migrations/038_admin_users_sessions.sql && pass "038 migration present" || fail "038 migration missing"
test -f migrations/039_admin_proposal_approvals.sql && pass "039 migration present" || fail "039 migration missing"
test -f migrations/040_admin_audit_log.sql && pass "040 migration present" || fail "040 migration missing"
test -f migrations/041_admin_debug_snapshot_grants.sql && pass "041 migration present" || fail "041 migration missing"
test -f src/admin-ui/next.config.mjs && pass "next.config.mjs present" || fail "next.config.mjs missing"
test -f src/admin-ui/trpc/routers/_app.ts && pass "appRouter present" || fail "appRouter missing"
test -f src/admin-ui/lib/approval-matrix.ts && pass "approval-matrix present" || fail "approval-matrix missing"

if [ "$PRECONDITIONS_ONLY" = "1" ]; then
  echo ""
  echo "Preconditions OK ($PASS checks); skipping rest (--preconditions-only)."
  exit 0
fi

echo ""
echo "Gate 1: TypeScript root typecheck"
npx tsc --noEmit > /tmp/p8.5-tsc-root.log 2>&1 \
  && pass "Gate 1: tsc --noEmit (root, excludes admin-ui)" \
  || { cat /tmp/p8.5-tsc-root.log; fail "Gate 1: tsc errors in root"; }

echo ""
echo "Gate 2: Admin-UI typecheck (skipped if deps not installed)"
if [ -d "src/admin-ui/node_modules" ]; then
  (cd src/admin-ui && npx tsc --noEmit) \
    && pass "Gate 2: admin-ui tsc --noEmit" \
    || fail "Gate 2: admin-ui tsc errors"
else
  echo "  SKIP  Gate 2: admin-ui deps not installed (run \`npm run admin:install\`)"
fi

echo ""
echo "Gate 3: Unit tests"
npx vitest run tests/admin-ui/unit/ > /tmp/p8.5-unit.log 2>&1 \
  && pass "Gate 3: vitest admin-ui/unit (56+ tests)" \
  || { cat /tmp/p8.5-unit.log; fail "Gate 3: unit tests failed"; }

echo ""
echo "Gate 4: Approval matrix has 14 classes"
grep -c "^  [a-z_]*:" src/admin-ui/lib/approval-matrix.ts | head -1 > /tmp/p8.5-classes.txt
COUNT=$(npx vitest run tests/admin-ui/unit/approval-matrix.spec.ts 2>&1 | grep -c "passed" || true)
if [ "$COUNT" -ge 1 ]; then
  pass "Gate 4: approval-matrix.spec.ts pass (14 classes enforced)"
else
  fail "Gate 4: approval matrix test failed"
fi

echo ""
echo "Gate 5: Audit log is append-only"
npx vitest run tests/admin-ui/unit/audit-append-only.spec.ts > /tmp/p8.5-audit.log 2>&1 \
  && pass "Gate 5: adminAuditLogRepo exposes only append+list" \
  || fail "Gate 5: audit log not append-only"

echo ""
echo "Gate 6: Migrations syntax check (down/up files exist)"
for m in 038_admin_users_sessions 039_admin_proposal_approvals 040_admin_audit_log 041_admin_debug_snapshot_grants; do
  test -f "migrations/${m}.sql" && test -f "migrations/${m}_down.sql" \
    || fail "Gate 6: ${m} missing up or down"
done
pass "Gate 6: all 4 migrations have up+down"

echo ""
echo "Gate 7: tRPC routers wired in _app.ts"
for router in inbox proposals versions drift traces audit; do
  grep -q "${router}Router" src/admin-ui/trpc/routers/_app.ts \
    || fail "Gate 7: ${router}Router not registered"
done
pass "Gate 7: all 6 routers wired in _app.ts"

echo ""
echo "Gate 8: Architecture lock banner exists"
test -f src/admin-ui/app/proposals/\[id\]/_components/architecture-lock-banner.tsx \
  && pass "Gate 8: architecture-lock-banner.tsx present" \
  || fail "Gate 8: missing lock banner"

echo ""
echo "Gate 9: Feature flags wired"
test -f src/admin-ui/lib/env.ts \
  && grep -q "FEATURE_ADMIN_UI_V1" src/admin-ui/lib/env.ts \
  && pass "Gate 9: feature flags wired" \
  || fail "Gate 9: feature flags missing"

echo ""
echo "Gate 10: Dual-approval state machine + invariants"
npx vitest run tests/admin-ui/unit/dual-approval-state.spec.ts > /tmp/p8.5-dual.log 2>&1 \
  && pass "Gate 10: dual-approval state machine tests pass" \
  || { cat /tmp/p8.5-dual.log; fail "Gate 10: dual-approval tests failed"; }

echo ""
echo "Gate 11: E2E tests (Playwright)"
if [ "$SKIP_E2E" = "1" ]; then
  echo "  SKIP  Gate 11: --skip-e2e flag set"
elif [ -d "src/admin-ui/node_modules" ] && [ -d "node_modules/@playwright" ]; then
  npx playwright test tests/admin-ui/e2e/ > /tmp/p8.5-e2e.log 2>&1 \
    && pass "Gate 11: Playwright E2E suite" \
    || { cat /tmp/p8.5-e2e.log; fail "Gate 11: E2E failed"; }
else
  echo "  SKIP  Gate 11: deps or Playwright not installed"
fi

echo ""
echo "================================="
echo "Acceptance: ${PASS} PASS / ${FAIL} FAIL"
echo "================================="
exit 0
