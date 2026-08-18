# cognition

**Path:** `src/cognition/`

**Purpose** — The agent's reasoning, reflection, and self-monitoring. Hosts the reflection pipeline (reflector → classifier → persister), the self-model with deterministic confidence, capability and skill proposers, the drift detector (7 types × 4 severities), the gap-escalation engine (4-level), the role selector chain, and step evaluators for skill execution. Outputs are *evidence* — never decisions.

## Key files

| File | Role |
|---|---|
| `src/cognition/runner.ts` | `runCognitiveModule()` — universal timeout/**cancellation**/fallback/audit wrapper (see [Cancellation contract](#cancellation-contract-issue-507)) |
| `src/cognition/reflector.ts` | Generates reflection candidates per trigger |
| `src/cognition/classifier.ts` | Routes candidates to typed destination |
| `src/cognition/persister.ts` | Persists classified outputs |
| `src/cognition/self-model.ts` | 3-layer model: domain / skill / gap |
| `src/cognition/confidence.ts` | Deterministic confidence formulas |
| `src/cognition/memory-classifier.ts` | Memory-type classifier |
| `src/cognition/capability-proposer.ts` | Proposes new capabilities |
| `src/cognition/capability-test-runner.ts` | Validates acquired capabilities post-hoc |
| `src/cognition/capability-tracker.ts` | Tracks capability lifecycle |
| `src/cognition/skill-proposer.ts` | Proposes specific skills |
| `src/cognition/procedure-builder.ts` | Builds procedure from teaching turns |
| `src/cognition/procedure-selector.ts` | Selects active procedure per turn |
| `src/cognition/procedure-status.ts` | Tracks execution status |
| `src/cognition/proposal-approval-handler.ts` | Hooks fired after owner approves a proposal |
| `src/cognition/proposal-approval-handlers/holiday.ts` | Holiday-specific approval handler |
| `src/cognition/step-evaluator.ts` | Generic step success check |
| `src/cognition/step-evaluator-llm-judge.ts` | LLM-as-judge evaluator |
| `src/cognition/step-evaluator-user-signal.ts` | User-signal evaluator |
| `src/cognition/behavioral-hint-deriver.ts` | Derives behavior hints |
| `src/cognition/holiday-descriptor.ts` | Holiday descriptor builder |
| `src/cognition/calendar-pattern-detector.ts` | Detects calendar patterns from turns |
| `src/cognition/drift/index.ts` | Drift detector entry — invokes 7 typed detectors |
| `src/cognition/drift/linguagem.ts`, `tom.ts`, `escopo.ts`, `papel.ts`, `confianca.ts`, `valores.ts`, `soul.ts`, `procedimento.ts`, `vies.ts` | Per-type detectors |
| `src/cognition/drift/decision-engine.ts` | Maps drift signals → silent / dashboard / mentionable / proposed |
| `src/cognition/gap-escalation/engine.ts` | 4-level escalation engine |
| `src/cognition/role-selector/engine.ts` | Role-selection orchestrator |
| `src/cognition/role-selector/llm-suggester.ts` | LLM suggests role |
| `src/cognition/role-selector/deterministic-classifier.ts` | Scores suggestion deterministically |
| `src/cognition/role-selector/policy-decider.ts` | Policy decides |
| `src/cognition/role-selector/oscillation-tracker.ts` | Anti-oscillation guard |

## Patterns it follows

- [Cognitive stack](../concerns/cognitive-stack.md) — trigger → candidate → classifier → typed destination
- [Tenant isolation](../concerns/tenant-isolation.md) — every cognitive write scopes by `tenant_id + agent_id`

## How to extend

| Need | Where |
|---|---|
| Add a new classifier destination | Extend `classifier.ts`; add typed persister; add tests for the new branch |
| Add a new drift detector | New file under `src/cognition/drift/`; register in `drift/index.ts`; add to `drift/types.ts` |
| Add a new step-evaluator strategy | New `step-evaluator-<name>.ts`; wire from `step-evaluator.ts` selector |
| Add a new approval handler | New file under `src/cognition/proposal-approval-handlers/`; register from `proposal-approval-handler.ts` |

## Public surface

| Consumed by | What |
|---|---|
| `src/cognitive-graph/` | Wraps cognitive modules as graph nodes via `runner.ts` |
| `src/agent/` | `reflection.ts` triggers reflector; agent core invokes via graph |
| `src/skills/` | Skill modes call step-evaluator |

## Cancellation contract (issue #507)

`runCognitiveModule` accepts an optional `signal` and hands the `fn` a
**composed** signal (caller cancellation + the module's own timeout). The `fn`
is what actually cancels: it must forward that signal to the underlying
operation (the LLM gateway's `signal` parameter). A `Promise.race` alone only
decides who answers the caller — the work keeps running and keeps being billed.

Four things follow from that, and they are the contract:

| Rule | Why |
|---|---|
| `status: 'cancelled'` is its own outcome, distinct from `timeout` and `error` | `timeout` is "our operation took too long"; `cancelled` is "authority over the turn changed hands". Collapsing them erases the split between budget spent on slowness and budget lost to takeover/shutdown. |
| `fallback_triggered` stays **false** on `cancelled`, and the fallback is never synthesized | Cancellation is not product degradation. Marking fallback here poisons the metric that measures how much worse an answer the user got. |
| A `fn` that resolves **after** the signal aborted has its output **discarded** (`metadata.cancel_cause = 'late_result_discarded'`) | A non-cooperative dependency still returns. The row used to say `success` for a turn that was no longer ours. The work was paid for either way; what must not happen is it becoming an answer, a mutation, or an audited success. |
| `signal` is **opt-in** | ~30 call sites run outside a claimed turn (batch workers, drift, KSM). Passing no signal keeps the previous behaviour byte-for-byte. |

Who passes it today: `src/agent/react-loop.ts` (reasoner) and
`src/agent/pending-gate.ts`, both from `getTurnExecutionContext()?.signal` —
the lease signal of issue #504. In the ReAct loop a `cancelled` reasoner is
translated into `TurnOwnershipLostError('react_reasoner')`, because letting it
fall through to `reasoner_failed` would make `core.ts` schedule a **retry** of a
turn another worker already owns.

Storage: `cognitive_module_log.status` admits `cancelled` since migration
`117_cognitive_module_log_cancelled.sql`.

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/cognition/` | Per-module contracts |
| `tests/unit/control-plane/knowledge-state-machine/` | KSM uses cognition outputs |

## In-flight changes

At last verification (2026-05-28):

- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)
- Cognition runner clearTimeout after Promise.race settle (#224 → #225 — merged)

Verify: `gh pr list --state open --search "cognition OR reflector OR drift"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
