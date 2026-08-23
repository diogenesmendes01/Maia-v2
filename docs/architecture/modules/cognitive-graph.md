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

## Turn cancellation (issue #507)

`GraphContext.signal` carries the claimed turn's `AbortSignal`
(`TurnExecutionContext.signal`, issue #504). `src/agent/core.ts` fills it from
`getTurnExecutionContext()?.signal`; `runOne` hands it to `runCognitiveModule`
**and** to `n.run(ctx, signal)` — the node implementation is what forwards it to
`callLLM`. Absent (outside a claimed turn) everything behaves exactly as before.

Two things this does NOT do, and the distinction matters:

- it does not stop the turn. A cancelled node returns `output: null`, which is
  indistinguishable from a timeout at the call site. `src/agent/core.ts` calls
  `assertTurnOwnership('preturn_graph')` right after `runNodes` and before
  reading `result.nodes[...]`, and that guard is what prevents
  `procedure_selector_decisions`, `startExecution` and `abortExecution` from
  running without ownership;
- it does not cover writes that happen **inside** a node. `selectRole` writes
  `role_selector_decisions` before returning, so it carries its own
  `assertTurnOwnership('role_selector_decision')`.

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
| `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts` | Lease lost mid-graph: the in-flight `callLLM` aborts and no post-graph write happens |

## In-flight changes

At last verification (2026-05-28):

- P7 cognitive-graph parity + flag removal (#412) — the graph is now the **sole** turn-time orchestration path. Every imperative side-effect has a node equivalent; the post-turn `step-evaluator-trigger` node was brought to full audit parity (`tool_called` / `criterion_checked` / `step_failed` / `branch_taken`); `FEATURE_COGNITIVE_GRAPH` (enum + env + singleton) and the imperative blocks in `src/agent/core.ts` were deleted. Broader-graph items (full DAG topology / arbitrary parallelization) remain roadmap but are not flag-gated.

Verify: `gh pr list --state open --search "cognitive-graph OR P7"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
