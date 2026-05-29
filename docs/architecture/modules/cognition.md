# cognition

**Path:** `src/cognition/`

**Purpose** — The agent's reasoning, reflection, and self-monitoring. Hosts the reflection pipeline (reflector → classifier → persister), the self-model with deterministic confidence, capability and skill proposers, the drift detector (7 types × 4 severities), the gap-escalation engine (4-level), the role selector chain, and step evaluators for skill execution. Outputs are *evidence* — never decisions.

## Key files

| File | Role |
|---|---|
| `src/cognition/runner.ts` | `runCognitiveModule()` — universal timeout/fallback/audit wrapper |
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
