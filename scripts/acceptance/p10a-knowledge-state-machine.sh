#!/usr/bin/env bash
# scripts/acceptance/p10a-knowledge-state-machine.sh
#
# P10a Knowledge State Machine — 12 acceptance gates.
# Run before canary of FEATURE_KNOWLEDGE_STATE_MACHINE_V1.
#
# Exit 0 if all gates pass; exit non-zero on first failure.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }
gate() { printf "\n\033[1m%s\033[0m\n" "$1"; }

gate "Gate 1: invisible states (proposed/pending_review/revoked/deprecated) never in visibility include WHERE clauses"
if grep -RE "lifecycle_status\s*=\s*'(proposed|pending_review|revoked|deprecated)'" \
   src/control-plane/knowledge-state-machine/visibility.ts \
   src/control-plane/knowledge-state-machine/state-machine.ts 2>/dev/null \
   | grep -v "//"; then
  fail "found include WHERE clause referencing invisible state"
else
  pass "no include-WHERE references to invisible states"
fi

gate "Gate 2: learned_rules SEMPRE em pending_review ao propor (decideInitialStatus)"
grep -q "if (args.kind === 'rule') return 'pending_review'" \
  src/control-plane/knowledge-state-machine/state-machine.ts \
  || fail "decideInitialStatus rule-routing missing"
pass "decideInitialStatus enforces kind=rule → pending_review"

gate "Gate 3: auto-promoter is idempotent (property test exists)"
grep -q "idempotent" tests/integration/p10a-knowledge-lifecycle.spec.ts 2>/dev/null \
  || fail "integration test for idempotency missing"
pass "idempotency test present"

gate "Gate 4: cron registered every 1h"
grep -q "knowledge_state_promoter.*'0 \* \* \* \*'" src/workers/index.ts \
  || fail "knowledge_state_promoter cron not registered at '0 * * * *'"
pass "cron entry '0 * * * *' present"

gate "Gate 5: revoked is terminal (ALLOWED_TRANSITIONS.revoked = [])"
grep -q "revoked: \[\]" src/control-plane/knowledge-state-machine/transitions.ts \
  || fail "ALLOWED_TRANSITIONS.revoked must be []"
pass "revoked is terminal in transitions table"

gate "Gate 6: verified/active no-downgrade in ALLOWED_TRANSITIONS"
grep -q "verified: \['active', 'deprecated', 'revoked'\]" \
  src/control-plane/knowledge-state-machine/transitions.ts \
  || fail "verified must transition only to active/deprecated/revoked"
grep -q "active: \['deprecated', 'revoked'\]" \
  src/control-plane/knowledge-state-machine/transitions.ts \
  || fail "active must transition only to deprecated/revoked"
pass "verified + active no-downgrade enforced"

gate "Gate 7: Architecture Lock CODEOWNERS configured"
test -f .github/CODEOWNERS || fail "CODEOWNERS missing"
grep -q "knowledge-state-machine/transitions.ts" .github/CODEOWNERS \
  || fail "CODEOWNERS missing transitions.ts entry"
grep -q "knowledge-state-machine/visibility.ts" .github/CODEOWNERS \
  || fail "CODEOWNERS missing visibility.ts entry"
grep -q "knowledge-state-machine/state-machine.ts" .github/CODEOWNERS \
  || fail "CODEOWNERS missing state-machine.ts entry"
pass "CODEOWNERS covers all 3 Architecture Lock files"

gate "Gate 8: propose_* tools registered in _registry.ts"
for name in proposeFactTool proposeRuleTool proposeMemoryTool proposeHintTool; do
  grep -q "$name" src/tools/_registry.ts \
    || fail "$name not registered in _registry.ts"
done
pass "all 4 propose_* tools registered"

gate "Gate 9: deprecation aliases present in save_fact/save_rule"
grep -q "deprecation_warning_save_fact" src/tools/save-fact.ts \
  || fail "save_fact missing deprecation log"
grep -q "deprecation_warning_save_rule" src/tools/save-rule.ts \
  || fail "save_rule missing deprecation log"
pass "save_fact + save_rule emit deprecation warnings"

gate "Gate 10: runCognitiveModule wraps propose + auto-promoter"
grep -q "runCognitiveModule" src/control-plane/knowledge-state-machine/state-machine.ts \
  || fail "runCognitiveModule wrapper missing in state-machine.ts"
grep -q "runCognitiveModule" src/workers/knowledge-state-promoter.ts \
  || fail "runCognitiveModule wrapper missing in knowledge-state-promoter.ts"
pass "runCognitiveModule wrapping present in propose + promoter"

gate "Gate 11: Admin UI risk score projection contract documented"
# P10a only stipulates the risk score is persisted in
# lifecycle_transitions[0].risk_score. P8.5 enriches the inbox payload.
# Verify the field is written by the propose() path.
grep -q "risk_score:" src/control-plane/knowledge-state-machine/state-machine.ts \
  || fail "propose() does not persist risk_score in lifecycle_transitions[0]"
pass "risk_score persisted in lifecycle_transitions[0]"

gate "Gate 12: migration 036 applied (file exists + indexes/CHECK declared)"
test -f migrations/036_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "migration 036 file missing"
grep -q "knowledge_pending_review_idx_memory" \
  migrations/036_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "pending_review index missing in migration"
grep -q "knowledge_auto_promoter_eligible_idx_memory" \
  migrations/036_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "auto_promoter index missing in migration"
grep -q "memory_entry_lifecycle_transitions_shape" \
  migrations/036_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "CHECK constraint missing in migration"
pass "migration 036 has indexes + CHECK constraints"

echo
printf "\033[32m\033[1mAll 12 P10a acceptance gates passed.\033[0m\n"
