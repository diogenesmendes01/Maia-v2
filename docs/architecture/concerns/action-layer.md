# Action Layer

> How a turn's intent becomes a side-effect. Spans `runtime/decision`, `skills`, `tools`, and `procedures`.

## 1. The invariant

**LLM proposes; backend disposes.** The LLM emits typed intents (Zod-validated structured output). The backend's decision engine selects a skill, validates risk and policy, executes via a deterministic runner, and audits the outcome. The LLM never:

- Writes to the database directly
- Decides whether an action is allowed
- Chooses between users/entities/accounts the user did not explicitly select
- Promotes itself to higher confidence than the backend permits

Every side-effect in the system passes through this layer. There is no shortcut.

## 2. Why it matters

This is what makes the system **auditable across operational roles**. *"The model decided"* is never a defensible audit trail; *"the rule in `governance/rules.ts:42` was applied to typed payload X by skill Y under policy Z"* is. The action layer turns LLM nondeterminism into governed, replayable, typed execution whether the agent is handling finance, sales, support, backoffice, or another tenant-defined role.

It is also where idempotency lives. Tools carry idempotency keys; the engine deduplicates by key before executing. A network retry, a worker re-delivery, or an LLM hallucinating the same tool call twice all converge to one execution.

## 3. Where it lives in code

### Decision engine (`src/runtime/decision/`)

| File | Role |
|---|---|
| `src/runtime/decision/decision-engine.ts` | Engine entry — orchestrates selection + execution |
| `src/runtime/decision/action-decider.ts` | Routes turns to skill / tool / procedure / fallback |
| `src/runtime/decision/skill-selector.ts` | Selects the candidate skill for a turn |
| `src/runtime/decision/skill-match.ts` | Strict match scoring (threshold `>`, not `>=`) |
| `src/runtime/decision/agent-selector.ts` | Selects which agent answers (single-agent today via channel policy; `MULTI_AGENT_SELECTOR_V2` flag reserved) |
| `src/runtime/decision/workflow-selector.ts` | Routes to workflows (dual-approval, pending questions) |
| `src/runtime/decision/intent-classifier.ts` | Intent classification step |
| `src/runtime/decision/turn-risk-scorer.ts` | Pre-execution risk score for the turn |
| `src/runtime/decision/risk-scorer.ts` | Generic risk-scoring primitives |
| `src/runtime/decision/early-pep.ts` / `mid-pep.ts` | Policy enforcement points (PEP) before / mid execution |
| `src/runtime/decision/pep-audit.ts` | Per-PEP audit emission |
| `src/runtime/decision/integration.ts` | Wires engine into agent loop |
| `src/runtime/decision/types.ts` | Shared types for engine input/output |

### Context packet (`src/runtime/context-packet/`, `src/runtime/context-assembly/`)

| File | Role |
|---|---|
| `src/runtime/context-packet/build-context-packet.ts` | Assembles context packet from slices |
| `src/runtime/context-packet/base-context-builder.ts` | Base context builder |
| `src/runtime/context-packet/production-builder-set.ts` | Production wiring with real `OperationalProfilePort` |
| `src/runtime/context-assembly/slice-builders/*.ts` | One builder per slice: identity, knowledge, policy, skill, soul, tool, user |
| `src/runtime/context-packet/cache/slice-cache.ts` | Per-slice cache with tenant-scoped keys |

### Skills (`src/skills/`)

| File | Role |
|---|---|
| `src/skills/skill-runner.ts` | `runSkill()` — universal skill execution entry |
| `src/skills/skill-slice-builder.ts` | Builds the skill's runtime slice from definition |
| `src/skills/cache.ts` | Skill result caching |
| `src/skills/modes/prompt-only.ts` | Mode: LLM-only execution (no external tools) |
| `src/skills/modes/evaluator.ts` | Mode: LLM-as-judge evaluation |
| `src/skills/modes/tool-mediated.ts` | Mode: skill invokes tools through the registry |
| `src/skills/modes/procedure-adapter.ts` | Mode: skill drives a procedure execution |
| `src/skills/index.ts` | Public surface |

### Tools (`src/tools/`)

Tools are Zod-typed functions registered via `src/tools/_registry.ts`. Each tool exports an `input` Zod schema and an `execute(args, ctx)` function. The registry is the single source of truth for what the LLM can call.

### Procedures (`src/procedures/`)

| File | Role |
|---|---|
| `src/procedures/engine.ts` | Stateful procedure execution engine |
| `src/procedures/test-runner.ts` | Test runner for procedure definitions |
| `src/procedures/` (other) | Event-sourced state machines with success criteria |

### Guardrails (`src/runtime/guardrails/`)

| File | Role |
|---|---|
| `src/runtime/guardrails/late-pep.ts` | Late policy enforcement (post-execution checks) |

## 4. Patterns

### 4.1 Typed intent → typed selection → typed execution

The LLM returns a Zod-validated intent. The decision engine matches it to a skill via `skill-selector.ts` + `skill-match.ts`. A strict `>` threshold is used in matching — equal-to-threshold scores do not select (avoids the LLM "just barely" earning execution). See `src/runtime/decision/skill-match.ts`.

Selected skill then runs via `runSkill()` in `skill-runner.ts` — uniform entry regardless of mode (prompt_only / evaluator / tool_mediated / procedure_adapter).

### 4.2 Three policy enforcement points (PEPs)

Risk and policy are checked at three points:

| PEP | When | Job |
|---|---|---|
| **Early PEP** | Before skill selection | Reject turns that hit hard limits (rate, scope, lockdown) |
| **Mid PEP** | After selection, before execution | Validate the selected skill is allowed for this `(agent, role, channel)` |
| **Late PEP** | After execution | Validate the outcome doesn't violate post-conditions |

Each PEP emits its own audit row via `pep-audit.ts`. A turn that succeeds touches three audit rows minimum.

### 4.3 Skill modes — same shape, different runner

All four skill modes (`src/skills/modes/`) implement the same interface but route differently:

- **prompt_only** — LLM call with the skill's prompt, no external tools. Cheapest. Used for classification, formatting, summarization within a known frame.
- **evaluator** — LLM-as-judge mode. Returns a typed verdict (pass/fail + reason) used to gate downstream action.
- **tool_mediated** — The skill orchestrates one or more tool calls. The LLM emits tool intents within the skill's scope.
- **procedure_adapter** — The skill drives a `procedures` execution. Multi-step, event-sourced, persistent across turns.

The runner does not branch on mode at every step; it delegates to the mode-specific module. Adding a new mode means adding a file under `src/skills/modes/` and registering it.

### 4.4 Idempotency at the tool boundary

Tools carry an `idempotency_key`. The governance idempotency cache (`src/governance/idempotency.ts`) deduplicates by `(tenant_id, agent_id, key)`. Same key → same execution; the second call returns the first's result without re-executing.

This handles: network retry, BullMQ re-delivery, LLM emitting the same call twice in one turn, user repeating an action.

### 4.5 Slice-builders for context

The context packet (`src/runtime/context-packet/`) is assembled from independent slices (`identity`, `knowledge`, `policy`, `skill`, `soul`, `tool`, `user`). Each slice has its own builder and its own cache. A slice can be invalidated (via `invalidation-bus.ts`) without rebuilding the entire packet. This keeps the per-turn cost bounded as the system's persistent state grows.

## 5. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| Tool that does a side-effect without idempotency key | Re-deliveries cause double-execution. Every side-effecting tool needs a key. |
| LLM returning the "final" response that contains numbers/decisions | Decisions are backend; the LLM formats from backend results. Never lets the LLM decide an amount, account, party, or status. |
| Skill bypassing PEP because "I know it's safe" | Late PEP exists for outcomes you can't predict at selection time. Always emit. |
| Tool registered outside `_registry.ts` | The registry is the single source of truth for callable surface. Off-registry tools are not auditable. |
| Procedure step that mutates state outside the engine | The engine's event-sourcing is what makes procedures replayable. Side-channel mutation breaks replay. |
| Match threshold of `>=` instead of `>` | Allows LLM intents that score exactly at the gate to execute. Use `>` (strict). See `skill-match.ts`. |
| Skill returning data the LLM uses to make a follow-up decision | The skill returns to the LLM the *result*; the LLM formats. If the LLM is going to make another decision from the result, that's another turn through the engine. |

## 6. Tests

| Test path | What it proves |
|---|---|
| `tests/unit/skills/` | Per-mode skill runner contracts |
| `tests/integration/skill-execution.spec.ts` (if present) | End-to-end skill execution |
| `tests/unit/decision/skill-match.spec.ts` | Strict `>` threshold |
| `tests/unit/action-decider/` | Routing decisions |
| `tests/unit/governance/idempotency.spec.ts` | Idempotency cache behavior |
| `tests/unit/skills-repo-cross-tenant.spec.ts` | Skill catalog stays tenant-scoped |

## 7. Known gaps

Re-verify at read time.

To find current gaps:

```bash
gh pr list --state open --search "skill OR decision OR action"
gh issue list --label "action-layer"
```

At last verification, decision-engine F1 was in Phase 1 (execute selected skill via `runSkill` for `prompt_only` + `evaluator`); `tool_mediated` and `procedure_adapter` integration was partial.

## 8. In-flight changes

At last verification (2026-05-28):

- Decision-engine F1 Phase 1 — execute selected skill via runSkill (#216 — merged)
- Decision-engine harden skill-match threshold to strict `>` (#219, #223 — merged)
- Decision-engine close Phase 0 anti-hijack + tenant-scoping gaps (#215 review, #217 — merged)
- Skills mutations + editor in admin-ui Phase 3 (#213 — merged)
- Skills activation TOCTOU race fix + runtime-gate (#213 follow-ups — merged)
- AbortSignal plumbed from SkillRunner to callLLM for prompt_only/evaluator (#221 — merged)
- Tool-mediated fail-closed on missing tenant context (#269 — open)
- Action-decider real fallback through skillsRepo.find with cross-tenant guard (#236 — open)

Verify with `gh pr list --state open --search "skill OR decision OR action"`.

## 9. Key decisions

- **`runSkill()` as the single skill execution entry** — uniform across modes; the runner does not branch on mode at every step.
- **Strict `>` in skill match** — score-equals-threshold does not select. Prevents LLM "just barely" earning execution. See `skill-match.ts`.
- **Three PEPs over one** — early/mid/late split lets each PEP have a narrow contract; outcomes are validated post-fact (late).
- **Idempotency on every side-effecting tool** — not optional; the registry contract requires it.
- **Slice-based context with per-slice cache** — keeps per-turn cost bounded as state grows; allows targeted invalidation.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | Older than 30 days; OR a new skill mode is added under `src/skills/modes/`; OR `decision-engine.ts` changes its PEP order; OR `_registry.ts` changes the tool contract |
