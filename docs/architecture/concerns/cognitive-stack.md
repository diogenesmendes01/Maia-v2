# Cognitive Stack

> How the agent thinks, reflects, and learns. Spans `cognition`, `cognitive-graph`, and `control-plane`.

## 1. The invariant

**The agent never edits its own behavior directly. It produces typed candidates; the cognitive graph orchestrates classification, scoring, and persistence; humans (or owner-defined policy) approve evolution.** Every cognitive output is *evidence*, not *decision*. Confidence is computed deterministically from evidence counts — the LLM never declares its own confidence.

This is the mechanical realization of the platform's promise — "agents learn from experience, but only evolve inside governance, scope, and evidence." The cognitive stack is the *learning*; governance is the *evolution gate*.

## 2. Why it matters

Without strict separation between cognition (which generates) and governance (which gates), the agent would self-modify in ways nobody can audit. Drift, misalignment, and capability creep become invisible. The cognitive stack's job is to make agent learning *observable* and *typed* — every reflection has a category (fact / rule / procedure / gap / tool request / discard) and an evidence trail. Governance can then decide what to keep.

The cognitive graph also bounds latency. A user message must produce a response within a budget; cognitive work that can't fit runs async or is skipped via `runWhen`. Without this discipline, "smarter" cognition silently makes responses slower until the agent stops being usable.

## 3. Where it lives in code

### Cognitive modules (`src/cognition/`)

| File | Role |
|---|---|
| `src/cognition/runner.ts` | `runCognitiveModule()` — universal wrapper: timeout, fallback, audit per invocation |
| `src/cognition/reflector.ts` | Generates reflection *candidates* from turns (conversation_closed, success_explicit, pattern_detected, internal_gap triggers) |
| `src/cognition/classifier.ts` | Routes each candidate into a typed destination (fact / rule / procedure / gap / tool request / discard) |
| `src/cognition/self-model.ts` | 3-layer self-model: domain / skill / gap, with deterministic confidence |
| `src/cognition/confidence.ts` | Confidence formulas — evidence-count over weighted denominator |
| `src/cognition/persister.ts` | Persists classified candidates into their typed targets |
| `src/cognition/capability-proposer.ts` | Proposes new capabilities the agent could acquire |
| `src/cognition/skill-proposer.ts` | Proposes specific skills (with success criteria) |
| `src/cognition/capability-test-runner.ts` | Runs post-acquisition validation tests |
| `src/cognition/memory-classifier.ts` | Memory-type classification (working/episodic/semantic/procedural/vector) |
| `src/cognition/procedure-selector.ts` | Selects procedure to apply when a turn matches one |
| `src/cognition/procedure-builder.ts` | Builds procedure from teaching-mode turns |
| `src/cognition/procedure-status.ts` | Maintains active execution status |
| `src/cognition/step-evaluator.ts` | Generic step success check (machine_check + tool_result) |
| `src/cognition/step-evaluator-llm-judge.ts` | LLM judge for evaluator-mode skills |
| `src/cognition/step-evaluator-user-signal.ts` | Reads user feedback as evaluation signal |
| `src/cognition/drift/index.ts` | Drift detector — 7 types: linguagem, tom, escopo, papel, confiança, valores, soul, viés, procedimento |
| `src/cognition/gap-escalation/engine.ts` | 4-level escalation: silent → dashboard → mentionable → proposed |
| `src/cognition/role-selector/engine.ts` | Selects operational role (LLM suggests, policy decides) |
| `src/cognition/role-selector/oscillation-tracker.ts` | Anti-oscillation guard for role switches |
| `src/cognition/behavioral-hint-deriver.ts` | Derives behavior hints from soul layer + memories |

### Cognitive graph (`src/cognitive-graph/`)

| File | Role |
|---|---|
| `src/cognitive-graph/orchestrator.ts` | Runs node lists by `CognitiveLayer`: SYNC_REQUIRED (serial), SYNC_CONDITIONAL (parallel + serial), ASYNC (fire-and-forget) |
| `src/cognitive-graph/preturn-graph.ts` | Nodes that run before the LLM call (context assembly, classification) |
| `src/cognitive-graph/postturn-graph.ts` | Nodes that run after the response (reflection, persistence, drift) |
| `src/cognitive-graph/registry.ts` | Module descriptor registry (`runWhen`, `timeout`, `fallback`, `model`, `version`) |
| `src/cognitive-graph/latency-budget.ts` | Per-turn latency budget enforcement |
| `src/cognitive-graph/types.ts` | `ModuleDescriptor`, `GraphContext`, `NodeRunResult` |

### Control plane (`src/control-plane/`)

| File | Role |
|---|---|
| `src/control-plane/knowledge-state-machine/state-machine.ts` | 9-state KSM lifecycle for learned facts/rules/procedures/hints |
| `src/control-plane/knowledge-state-machine/transitions.ts` | State transition methods (proposed → reviewed → accepted/rejected/revoked) |
| `src/control-plane/knowledge-state-machine/risk-scorer.ts` | Pre-promotion risk scoring |
| `src/control-plane/knowledge-state-machine/repos.ts` | Tenant-scoped persistence for KSM rows |
| `src/control-plane/policy/policy-rules-repo.ts` | Policy rules over capabilities/roles/skills |
| `src/control-plane/policy/policy-cache.ts` | Cached policy lookup with per-tenant pubsub invalidation |
| `src/control-plane/runtime-trace/envelope-writer.ts` | Sync envelope writer (P10b dual-pattern trace) |
| `src/control-plane/runtime-trace/body-writer.ts` | Async body writer for trace details |
| `src/control-plane/skill-registry/skills-repo.ts` | Persistent skill catalog with status (proposed/active/revoked) |
| `src/control-plane/soul/soul-biases-repo.ts` | Append-only behavioral biases per agent |

## 4. Patterns

### 4.1 Trigger → Candidate → Classifier → Typed destination

The reflection pipeline is uniformly typed. Triggers fire (`reflector.ts`), produce reflection *candidates* — never raw learnings — and the classifier (`classifier.ts`) routes each candidate to one of six typed destinations:

| Destination | Storage | What it represents |
|---|---|---|
| **Fact** | `agent_memories` (semantic / vector) | Something true about a tenant's world |
| **Rule** | `learned_rules` via KSM | A behavior rule to apply when conditions match |
| **Procedure** | `procedure_definitions` | A multi-step process to execute |
| **Gap** | `gap_escalation_engine` | An ability the agent lacks |
| **Tool request** | `capability_proposals` | A specific tool/skill the agent wants |
| **Discard** | (nothing, but logged) | The candidate was not actionable |

No reflection bypasses the classifier. No new destination is added without a schema change + corresponding case.

### 4.2 Three execution layers in the cognitive graph

`src/cognitive-graph/orchestrator.ts:23-67` partitions nodes by `CognitiveLayer`:

- **SYNC_REQUIRED** — serial, in array order. Failures still return fallback (the response doesn't block).
- **SYNC_CONDITIONAL** — `parallelizable=true` nodes run via `Promise.all`; others serial. `runWhen` may skip.
- **ASYNC** — fire-and-forget. Returns a placeholder result immediately; errors are logged.

A mixed-layer array is allowed but uncommon — callers typically batch by layer.

### 4.3 Deterministic confidence from evidence

`src/cognition/confidence.ts` exposes formulas like `acertos / (acertos + erros + weight * unknowns)`. The LLM never produces a confidence number. The self-model (`self-model.ts`) reads evidence counters from persistent storage and computes confidence on demand. This means confidence is reproducible from the data — no LLM whim, no drift between two consecutive computations on the same inputs.

### 4.4 LLM proposes, policy decides (role-selector)

The role selector (`src/cognition/role-selector/`) is a clean instance of the broader pattern. The LLM suggests a role (`llm-suggester.ts`); a deterministic classifier scores it (`deterministic-classifier.ts`); a policy decides whether to accept the suggestion (`policy-decider.ts`); an oscillation tracker rejects rapid switches (`oscillation-tracker.ts`). The agent does not declare its own role.

### 4.5 KSM: 9 states for learned knowledge

The Knowledge State Machine (P10a) tracks every learned rule through:

```
proposed → reviewed → accepted → active → revoked
                ↓
            rejected
                ↓
          superseded → archived
```

(Exact states verified in `src/control-plane/knowledge-state-machine/state-machine.ts`.) Transitions are tenant-scoped, risk-scored, and audited.

## 5. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| LLM returning a confidence value used downstream | Confidence is deterministic. Use evidence counts + `confidence.ts` formulas. |
| Reflection candidates written directly to typed tables | They must go through the classifier first. Otherwise classification logic forks. |
| Async cognitive work without timeout | A cognitive node that misses its budget should fall back, not pile up. Always set `timeoutMs` in the descriptor. |
| Direct mutation of operational profile from inside cognition | Cognition *proposes* changes (`capability-proposer`, `skill-proposer`); never writes to the operational profile. |
| Skipping `runWhen` | A node that runs unconditionally even when its preconditions aren't met wastes budget and adds noise. Use `runWhen` aggressively. |
| Modifying KSM rows with `WHERE id = ?` | Mutations must include `tenant_id + agent_id` — see [`tenant-isolation.md`](tenant-isolation.md). |

## 6. Tests

| Test path | What it proves |
|---|---|
| `tests/integration/p10a-knowledge-lifecycle.spec.ts` | KSM 9-state lifecycle with tenant scoping |
| `tests/property/knowledge-state-machine.spec.ts` | Property-based KSM invariants |
| `tests/unit/control-plane/knowledge-state-machine/ksm-rules-cross-tenant.spec.ts` | KSM transitions are tenant-scoped |
| `tests/unit/cognition/` (multiple) | Per-module reflector/classifier/persister contracts |
| `tests/unit/constitutional.spec.ts` | Constitutional rules — non-negotiable cognitive invariants |

## 7. Known gaps

Re-verify at read time. Authoritative source: GitHub issues + open PRs.

To find current gaps:

```bash
gh issue list --label "cognition"
gh pr list --state open --search "ksm OR cognition OR drift"
```

The turn-time cognitive graph (P7) is the **sole** orchestration path as of issue #412: every turn-time module the imperative legacy path ran is wired as a graph node, parity of DB side-effects (`selector_decisions`, the full `procedure_execution_events` set, reflection rows) was proven by `tests/integration/p7-cognitive-graph-parity.spec.ts`, and the `FEATURE_COGNITIVE_GRAPH` toggle plus the imperative blocks in `src/agent/core.ts` were removed. (Broader-graph items — full DAG topology / arbitrary parallelization beyond the current sync_conditional batch — remain roadmap, but they are not gated by a flag.) See `README.md` § Estado atual for the runtime status.

## 8. In-flight changes

At last verification (2026-05-28):

- P7 cognitive-graph parity + flag removal (#412) — graph is now the sole turn-time orchestration path; `FEATURE_COGNITIVE_GRAPH` removed; post-turn `step-evaluator-trigger` node brought to full audit parity (now emits `tool_called`/`criterion_checked`/`step_failed`/`branch_taken`)
- KSM scoping fixes: per-row context for promoter (#280), bounded retry loop for revoke under optimistic-conflict (#279)
- KSM fact/memory/hint scope by `tenant_id+agent_id` (#254, #267 — merged)
- Reflection memory cleanup for pre-fix pollution (#276)
- Decision-engine F1 phase 1 — execute selected skill via runSkill (`#216` — merged)

Verify the current list with `gh pr list --state open --search "ksm OR cognition OR reflector"`.

## 9. Key decisions

- **Reflections are candidates, not learnings** — every cognitive output goes through `classifier.ts` before storage. No bypass.
- **Confidence is deterministic** — formulas in `confidence.ts`, never the LLM. Reproducibility is part of the contract.
- **Three explicit layers** — SYNC_REQUIRED / SYNC_CONDITIONAL / ASYNC make latency visible at the descriptor level, not buried inside each module.
- **KSM as the single lifecycle for learned knowledge** — facts, rules, procedures, hints all transition through the same 9 states. Avoids per-type state machines drifting.
- **Soul layer is append-only** — behavioral biases never delete; they're versioned and superseded.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | Older than 30 days; OR `src/cognition/classifier.ts` adds a destination; OR `src/cognitive-graph/orchestrator.ts` changes its layer semantics; OR KSM states change in `src/control-plane/knowledge-state-machine/state-machine.ts` |
