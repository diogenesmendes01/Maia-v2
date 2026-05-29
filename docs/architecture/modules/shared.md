# shared

**Path:** `src/shared/`

**Purpose** — Cross-module primitives that don't fit cleanly in any single subsystem. Currently scoped to risk-scoring primitives shared between decision engine, KSM, and other gates: heuristic scoring, level mapping, LLM-based gating, the generic scorer interface, and shared types.

## Key files

| File | Role |
|---|---|
| `src/shared/risk/scorer.ts` | Generic risk-scorer interface |
| `src/shared/risk/heuristic.ts` | Heuristic scoring primitives |
| `src/shared/risk/level.ts` | Score → level mapping |
| `src/shared/risk/llm-gate.ts` | LLM-as-gate for risk decisions |
| `src/shared/risk/types.ts` | Shared types |

## Patterns it follows

- One module per concern — risk-scoring lives here because both `src/runtime/decision/` and `src/control-plane/knowledge-state-machine/` use it. Don't duplicate the primitive in each consumer.

## How to extend

| Need | Where |
|---|---|
| Add a new shared primitive | New subdirectory `src/shared/<concern>/`; export types + functions |
| Add a risk dimension | Extend `src/shared/risk/types.ts`; update scorer + heuristic |
| Add an LLM gate strategy | Extend `llm-gate.ts`; keep deterministic decision over LLM verdict |

## Public surface

| Consumed by | What |
|---|---|
| `src/runtime/decision/risk-scorer.ts` | Turn risk scoring |
| `src/runtime/decision/turn-risk-scorer.ts` | Turn-level risk |
| `src/control-plane/knowledge-state-machine/risk-scorer.ts` | KSM promotion risk |
| `src/control-plane/knowledge-state-machine/knowledge-risk-scorer.ts` | Knowledge-specific risk |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/shared/risk/` | Heuristic + level + gate contracts |

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/shared/`.

Verify: `gh pr list --state open --search "shared OR risk-scorer"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
