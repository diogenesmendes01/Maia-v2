# cognitive-graph

**Path:** `src/cognitive-graph/`

**Purpose** — Lightweight DAG orchestration over cognitive modules. Partitions nodes by execution layer (`SYNC_REQUIRED` serial, `SYNC_CONDITIONAL` parallel + serial, `ASYNC` fire-and-forget), enforces a per-turn latency budget, and gates nodes via `runWhen` predicates. Two graphs: pre-turn (before LLM call) and post-turn (after response). Replaces ad-hoc cognitive sequencing with a declarative descriptor format.

## Key files

| File | Role |
|---|---|
| `src/cognitive-graph/orchestrator.ts` | `runNodes()` — partitions by layer; runs serial/parallel/async accordingly |
| `src/cognitive-graph/preturn-graph.ts` | Pre-turn node list |
| `src/cognitive-graph/postturn-graph.ts` | Post-turn node list |
| `src/cognitive-graph/registry.ts` | Node descriptor registry |
| `src/cognitive-graph/latency-budget.ts` | Per-turn latency budget tracker |
| `src/cognitive-graph/types.ts` | `ModuleDescriptor`, `GraphContext`, `NodeRunResult`, `GraphRunResult` |

## Patterns it follows

- [Cognitive stack](../concerns/cognitive-stack.md) — three execution layers; descriptors carry `runWhen`, `timeoutMs`, `fallback`, `model`, `version`
- [Governance + observability](../concerns/governance-observability.md) — every node invocation audits via `runCognitiveModule()`

## How to extend

| Need | Where |
|---|---|
| Add a cognitive module as a graph node | Wrap with `ModuleDescriptor` in `registry.ts`; add to `preturn-graph.ts` or `postturn-graph.ts` |
| Change execution policy | Extend `CognitiveLayer` enum in `src/types/enums.ts`; handle in `orchestrator.ts:runNodes()` |
| Adjust latency budget | Edit `latency-budget.ts` policy; never bypass per-node `timeoutMs` |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/core.ts` | Invokes pre-turn and post-turn graphs around the LLM call — **unconditionally** since #412 (the `FEATURE_COGNITIVE_GRAPH` toggle and the imperative legacy path were removed) |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/cognitive-graph-orchestrator.spec.ts` | Layer partitioning, timeout/fallback, runWhen skip |
| `tests/unit/preturn-graph.spec.ts` / `tests/unit/postturn-graph.spec.ts` | Node composition + layers + runWhen gating |
| `tests/unit/cognitive-graph-latency-budget.spec.ts` | p95 + budget math |
| `tests/integration/p7-cognitive-graph.spec.ts` | Audit-invariant: every node invocation writes `cognitive_module_log` |
| `tests/integration/p7-cognitive-graph-parity.spec.ts` | DB side-effect parity (#412): step-evaluator emits the full `procedure_execution_events` set; reflection nodes persist candidates |

## In-flight changes

At last verification (2026-05-28):

- P7 cognitive-graph parity + flag removal (#412) — the graph is now the **sole** turn-time orchestration path. Every imperative side-effect has a node equivalent; the post-turn `step-evaluator-trigger` node was brought to full audit parity (`tool_called` / `criterion_checked` / `step_failed` / `branch_taken`); `FEATURE_COGNITIVE_GRAPH` (enum + env + singleton) and the imperative blocks in `src/agent/core.ts` were deleted. Broader-graph items (full DAG topology / arbitrary parallelization) remain roadmap but are not flag-gated.

Verify: `gh pr list --state open --search "cognitive-graph OR P7"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
