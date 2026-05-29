# procedures

**Path:** `src/procedures/`

**Purpose** — Event-sourced state-machine engine for multi-step agent procedures. A procedure is a versioned definition (steps, success criteria, typed result schema). An execution is a stateful instance with events recorded immutably. The engine drives transitions; the test runner validates definitions before activation. P3a (definition + teaching mode) and P3b (runtime execution) are in production; P3c (full governance with materialized metrics view, full step-evaluator chain, reaper for zombie executions) is partial.

## Key files

| File | Role |
|---|---|
| `src/procedures/engine.ts` | Stateful execution engine: drives transitions, records events, evaluates steps |
| `src/procedures/test-runner.ts` | Runs `procedure_tests` against definitions pre-activation |

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — procedures execute via skills (mode: `procedure_adapter`)
- [Cognitive stack](../concerns/cognitive-stack.md) — `procedure-builder` (in `cognition`) turns teaching turns into definitions
- [Governance + observability](../concerns/governance-observability.md) — every execution event audits; success criteria are typed

## How to extend

| Need | Where |
|---|---|
| Add a new step type | Extend the typed step schema; engine maps step type → handler |
| Add a new success-criterion type | Extend `step-evaluator.ts` (in `src/cognition/`); engine reads evaluator verdict |
| Add post-execution hook | New hook point in engine; document audit semantics |
| Cancel a hung execution | `procedure-execution-reaper` worker handles TTL-based termination |

## Public surface

| Consumed by | What |
|---|---|
| `src/skills/modes/procedure-adapter.ts` | Drives procedure execution from a skill |
| `src/cognition/procedure-selector.ts` | Selects which procedure applies |
| `src/cognition/procedure-builder.ts` | Builds definitions from teaching turns |
| `src/workers/procedure-execution-reaper.ts` | Reaps zombies |
| `src/workers/procedure-metrics-refresh.ts` | Refreshes `procedure_metrics` materialized view |
| `src/workers/procedure-candidate-consumer.ts` | Consumes candidate procedures from queue |
| `src/admin-ui/src/server/routers/procedures.ts` | Owner-facing surface |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/procedures/engine.spec.ts` | Engine state transitions |
| `tests/unit/procedures/test-runner.spec.ts` | Pre-activation test runner |
| `tests/integration/procedures/` | End-to-end procedure execution |

## In-flight changes

At last verification (2026-05-28):

- P3c governance — partial: `procedure_metrics` materialized view, full test runner, full step-evaluator (`llm_judge` / `user_signal` / `human_confirmed`) iterating

Verify: `gh pr list --state open --search "procedure OR p3c"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
