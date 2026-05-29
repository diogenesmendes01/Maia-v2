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
| `src/agent/core.ts` | Invokes pre-turn and post-turn graphs around the LLM call |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/cognitive-graph/` | Layer partitioning, timeout/fallback, runWhen skip |

## In-flight changes

At last verification (2026-05-28):

- Cognitive graph refactor (P7) is partial — orchestrator + descriptor pattern landed; not every cognitive module is wired through the graph yet (see `README.md` § Estado atual)

Verify: `gh pr list --state open --search "cognitive-graph OR P7"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
