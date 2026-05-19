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

gate "Gate 12: migration 050 applied (file exists + indexes/CHECK declared)"
test -f migrations/050_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "migration 050 file missing"
grep -q "knowledge_pending_review_idx_memory" \
  migrations/050_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "pending_review index missing in migration"
grep -q "knowledge_auto_promoter_eligible_idx_memory" \
  migrations/050_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "auto_promoter index missing in migration"
grep -q "memory_entry_lifecycle_transitions_shape" \
  migrations/050_p10a_ksm_lifecycle_and_indexes.sql \
  || fail "CHECK constraint missing in migration"
pass "migration 050 has indexes + CHECK constraints"

# ============================================================
# Post-review #104 gates — DB enforcement, visibility, concurrency,
# runtime feature gate, per-table maturity filter.
# ============================================================

gate "Gate 13: migration 051 — enforce_lifecycle_transition trigger on all 4 tables"
test -f migrations/051_p10a_enforce_lifecycle_transition.sql \
  || fail "migration 051 file missing"
for tbl in memory_entry agent_facts learned_rules behavioral_hint; do
  grep -q "trg_enforce_lifecycle_transition_${tbl}" \
    migrations/051_p10a_enforce_lifecycle_transition.sql \
    || fail "trigger for ${tbl} missing in migration 051"
done
grep -q "illegal knowledge lifecycle transition" \
  migrations/051_p10a_enforce_lifecycle_transition.sql \
  || fail "trigger function must raise EXCEPTION on illegal transition"
pass "DB-level lifecycle enforcement trigger present on all 4 tables"

gate "Gate 14: visibility filter mandatory on every LLM-facing read path"
# Scan from each function signature for the next 80 lines and confirm
# lifecycle_status is referenced inside. Brace-balanced scanning is
# brittle here because the function signatures span multiple lines with
# objects on them.
for fn in "listForScopes" "listMentionableForScopes" "listActive" "findRelevant" "findActiveForScope"; do
  awk -v f="$fn" '
    BEGIN { found = 0; in_fn = 0; window = 0 }
    $0 ~ "async " f "\\(" { in_fn = 1; window = 0 }
    in_fn { window++ }
    in_fn && /lifecycle_status/ { found = 1; exit }
    in_fn && window > 80 { in_fn = 0 }
    END { exit (found ? 0 : 1) }
  ' src/db/repositories.ts || fail "$fn does not reference lifecycle_status in its WHERE"
done
pass "all 5 LLM-facing read paths filter by lifecycle_status"

gate "Gate 15: state-machine.transition uses optimistic-concurrency expected_previous_status"
grep -q "expected_previous_status: current.lifecycle_status" \
  src/control-plane/knowledge-state-machine/state-machine.ts \
  || fail "transition() must pass expected_previous_status for optimistic locking"
grep -q "KnowledgeConflictError" \
  src/control-plane/knowledge-state-machine/state-machine.ts \
  || fail "transition() must catch KnowledgeConflictError"
pass "state-machine.transition is atomic via expected_previous_status"

gate "Gate 16: propose_* tools gated by runtime feature flag (featureFlags.isEnabled)"
grep -q "featureFlags.isEnabled(FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1)" \
  src/tools/_registry.ts \
  || fail "_registry.ts must use featureFlags.isEnabled (runtime singleton)"
grep -q "isToolEnabled" src/tools/_dispatcher.ts \
  || fail "_dispatcher.ts must reject disabled tools via isToolEnabled"
grep -q "featureFlags.isEnabled(FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1)" \
  src/workers/knowledge-state-promoter.ts \
  || fail "knowledge-state-promoter must use featureFlags.isEnabled (runtime singleton)"
pass "propose_* tools + worker gated by featureFlags.isEnabled() runtime"

gate "Gate 17: per-table maturity filter (no COALESCE confidence,confianca)"
# Only flag the bad pattern when it appears in executable code — comments
# documenting why we replaced it are fine. We grep for the SQL fragment
# inside backtick-quoted sql\`...\` template literals.
if grep -E "sql\`.*COALESCE\(confidence, confianca" src/workers/knowledge-state-promoter.ts; then
  fail "knowledge-state-promoter still uses the invalid COALESCE pattern in executable SQL"
fi
grep -q "maturityFilter" src/workers/knowledge-state-promoter.ts \
  || fail "maturityFilter per-table predicate factory not used"
pass "verified→active uses per-table maturity predicate"

gate "Gate 18: BFS reachability + idempotency property tests present"
test -f tests/property/knowledge-state-machine.spec.ts \
  || fail "property tests file missing"
grep -q "no path exists from revoked to active" tests/property/knowledge-state-machine.spec.ts \
  || fail "BFS reachability test missing"
grep -q "100 sequential ticks" tests/property/knowledge-state-machine.spec.ts \
  || fail "idempotency 100-iteration test missing"
pass "BFS reachability + 100-iter idempotency property tests present"

echo
printf "\033[32m\033[1mAll 18 P10a acceptance gates passed.\033[0m\n"
