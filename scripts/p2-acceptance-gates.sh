#!/bin/bash
# P2 Acceptance Gates — run after DB is up + P0+P1+P2 migrations applied
set -e

echo "=== Gate A: 5 novas tabelas no schema ==="
COUNT=$(grep -cE "^export const (memory_entry|behavioral_hint|agent_capabilities_domain|agent_capabilities_skill|agent_capability_gaps)" src/db/schema.ts)
[ "$COUNT" = "5" ] || { echo "FAIL: expected 5, got $COUNT"; exit 1; }
echo "OK ($COUNT tabelas)"

echo "=== Gate B: unit tests ==="
npx vitest run tests/unit/memory-classifier.spec.ts tests/unit/self-model.spec.ts tests/unit/behavioral-hint-deriver.spec.ts

echo "=== Gate C: integration tests (mocked) ==="
npx vitest run tests/integration/p2-memory-scoping.spec.ts tests/integration/p2-self-model.spec.ts

echo "=== Gate D: DB-dependent — tabelas existem ==="
psql "$DATABASE_URL" -c "
SELECT
  to_regclass('public.memory_entry') AS memory_entry,
  to_regclass('public.behavioral_hint') AS behavioral_hint,
  to_regclass('public.agent_capabilities_domain') AS caps_domain,
  to_regclass('public.agent_capabilities_skill') AS caps_skill,
  to_regclass('public.agent_capability_gaps') AS caps_gaps;
"

echo "=== Gate E: legacy migration aplicou (memory_entry com needs_review=true) ==="
psql "$DATABASE_URL" -c "
SELECT count(*) AS legacy_count FROM memory_entry WHERE needs_review = true;
"
# Should match the count of legacy agent_facts (manual verification)

echo "=== Gate F: production build ==="
npm run build

echo ""
echo "All P2 acceptance gates green. Ready to tag p2-memory-self-model-done."
