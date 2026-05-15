#!/bin/bash
# P3a Acceptance Gates — run after DB up + P0+P1+P2+P3a migrations applied
set -e

echo "=== Gate A: 2 novas tabelas no schema ==="
COUNT=$(grep -cE "^export const (procedure_definitions|procedure_assignments)" src/db/schema.ts)
[ "$COUNT" = "2" ] || { echo "FAIL: expected 2, got $COUNT"; exit 1; }
echo "OK"

echo "=== Gate B: unit tests ==="
npx vitest run tests/unit/procedure-builder.spec.ts tests/unit/procedure-status.spec.ts

echo "=== Gate C: integration test ==="
npx vitest run tests/integration/p3a-procedure-lifecycle.spec.ts

echo "=== Gate D: tabelas DB ==="
psql "$DATABASE_URL" -c "
SELECT
  to_regclass('public.procedure_definitions'),
  to_regclass('public.procedure_assignments');
"

echo "=== Gate E: production build ==="
npm run build

echo ""
echo "All P3a acceptance gates green. Ready to tag p3a-procedures-done."
