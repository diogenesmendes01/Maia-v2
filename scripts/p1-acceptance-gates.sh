#!/bin/bash
# P1 Acceptance Gates — run after DB is up + migrations applied

set -e

echo "=== Code-level gates (no DB) ==="
echo "→ enums expanded"
grep -qE "SUCCESS_EXPLICIT" src/types/enums.ts || { echo "FAIL: enums missing"; exit 1; }
echo "OK"

echo "→ unit tests: runner + classifier + detectors"
npx vitest run tests/unit/cognition-runner.spec.ts tests/unit/cognition-classifier.spec.ts tests/unit/success-detector.spec.ts tests/unit/gap-detector.spec.ts

echo "→ integration test (mocked)"
npx vitest run tests/integration/p1-reflection-expansion.spec.ts

echo ""
echo "=== DB-dependent gates ==="
echo "→ migration 013 applied (cognitive_candidates exists)"
psql "$DATABASE_URL" -c "SELECT to_regclass('public.cognitive_candidates') AS exists;" \
  | grep -q 'cognitive_candidates' || { echo "FAIL: cognitive_candidates table missing — run npm run db:migrate"; exit 1; }
echo "OK"

echo "→ cognitive_candidates accepts inserts"
psql "$DATABASE_URL" -c "
INSERT INTO cognitive_candidates
  (tenant_id, agent_id, source_event_type, candidate_type, payload)
VALUES
  ('default', 'default', 'test', 'lacuna', '{\"test\": true}');
SELECT count(*) FROM cognitive_candidates WHERE source_event_type = 'test';
DELETE FROM cognitive_candidates WHERE source_event_type = 'test';
"

echo "→ cognitive_module_log registers reflector/classifier executions"
psql "$DATABASE_URL" -c "
SELECT module_name, count(*)
FROM cognitive_module_log
WHERE module_name LIKE 'reflector%' OR module_name LIKE 'classifier%' OR module_name = 'classifier'
GROUP BY module_name;
"
echo "(If empty, no reflection events have fired yet — run a manual reflection or wait for workers)"

echo ""
echo "=== Production build ==="
npm run build

echo ""
echo "All P1 acceptance gates checked. Ready to tag p1-reflection-done if everything green."
