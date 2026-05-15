#!/bin/bash
# P3b Acceptance Gates — run after DB up + migrations applied
set -e

echo "=== Gate A: 3 novas tabelas no schema ==="
COUNT=$(grep -cE "^export const (procedure_executions|procedure_execution_events|procedure_selector_decisions)" src/db/schema.ts)
[ "$COUNT" = "3" ] || { echo "FAIL: expected 3, got $COUNT"; exit 1; }
echo "OK"

echo "=== Gate B: unit tests ==="
npx vitest run tests/unit/procedure-selector.spec.ts tests/unit/step-evaluator.spec.ts tests/unit/procedure-engine.spec.ts

echo "=== Gate C: integration test ==="
npx vitest run tests/integration/p3b-procedure-runtime.spec.ts

echo "=== Gate D: tabelas DB ==="
psql "$DATABASE_URL" -c "
SELECT
  to_regclass('public.procedure_executions'),
  to_regclass('public.procedure_execution_events'),
  to_regclass('public.procedure_selector_decisions');
"

echo "=== Gate E: production build ==="
npm run build

echo ""
echo "All P3b acceptance gates green. Ready to tag p3b-procedure-runtime-done."
