# runtime

**Path:** `src/runtime/`

**Purpose** — Per-turn runtime infrastructure between gateway and agent: the decision engine, the context packet assembly (slice builders + cache), policy enforcement points (PEPs), and feature flags that gate runtime behaviors. The decision engine takes a typed turn and produces a typed selection (skill / tool / procedure / fallback) via action-decider + skill-selector + risk-scoring. Context packet is rebuilt per turn from independently-cached slices.

## Key files

### Decision (`src/runtime/decision/`)

| File | Role |
|---|---|
| `decision-engine.ts` | Engine entry |
| `action-decider.ts` | Routes turns to skill / tool / procedure / fallback |
| `skill-selector.ts` | Selects candidate skill |
| `skill-match.ts` | Strict `>` threshold matching |
| `agent-selector.ts` | Selects answering agent (no-op today; `MULTI_AGENT_SELECTOR_V2` reserved) |
| `workflow-selector.ts` | Routes to workflows (dual-approval, pending) |
| `intent-classifier.ts` | Intent classification |
| `turn-risk-scorer.ts` | Pre-execution turn risk |
| `risk-scorer.ts` | Generic risk-scoring primitives |
| `early-pep.ts`, `mid-pep.ts` | Policy enforcement points |
| `pep-audit.ts` | Per-PEP audit emission |
| `budget-tracker.ts` | Per-turn budget |
| `integration.ts` | Wires engine into agent loop |
| `prod-env.ts` | Production-only env helpers |
| `types.ts` | Shared types |

### Context packet (`src/runtime/context-packet/`)

| File | Role |
|---|---|
| `build-context-packet.ts` | Assembles packet from slices |
| `base-context-builder.ts` | Base builder |
| `production-builder-set.ts` | Production wiring with real ports |
| `decision-packet-stub.ts` | Stubbed decision packet for early phases |
| `cache/slice-cache.ts` | Per-slice cache (tenant-scoped) |
| `cache/invalidation-bus.ts` | Cross-process invalidation |
| `cache/ttl-policy.ts` | TTL per slice type |
| `types.ts` | Shared types |

### Context assembly (`src/runtime/context-assembly/`)

| Slice | Builder |
|---|---|
| Identity | `slice-builders/identity-slice-builder.ts` |
| Knowledge | `slice-builders/knowledge-slice-builder.ts` |
| Policy | `slice-builders/policy-slice-builder.ts` |
| Skill | `slice-builders/skill-slice-builder.ts` |
| Soul | `slice-builders/soul-slice-builder.ts` |
| Tool | `slice-builders/tool-slice-builder.ts` |
| User | `slice-builders/user-slice-builder.ts` |

### Feature flags (`src/runtime/feature-flags/`)

| File | Role |
|---|---|
| `decision-engine-flag.ts` | Gates F1 decision-engine usage |
| `context-packet-flag.ts` | Gates context-packet usage |

### Guardrails (`src/runtime/guardrails/`)

| File | Role |
|---|---|
| `late-pep.ts` | Late policy enforcement (post-execution) |

### Prompt (`src/runtime/prompt/`)

| File | Role |
|---|---|
| `build-prompt-from-packet.ts` | Renders prompt from context packet |

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — decision engine + PEPs + skill modes
- [Tenant isolation](../concerns/tenant-isolation.md) — every slice cache key includes tenant
- [Governance + observability](../concerns/governance-observability.md) — each PEP emits audit
- [Channel/role/policy](../concerns/channel-policy.md) — agent-selector reads channel_policy

## How to extend

| Need | Where |
|---|---|
| Add a decision step | New file under `src/runtime/decision/`; wire from `decision-engine.ts`; emit audit |
| Add a context slice | New builder under `slice-builders/`; new entry in `cache/ttl-policy.ts`; register in `production-builder-set.ts` |
| Add a feature flag | New file under `feature-flags/`; default `false`; reference from gated code |
| Add a PEP | New PEP file (`<n>-pep.ts`); emit audit; document in `governance-observability.md` |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/core.ts` | Invokes decision engine per turn |
| `src/skills/` | Receives decision output |
| `src/cognitive-graph/` | Builds context for graph nodes |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/decision/skill-match.spec.ts` | Strict `>` threshold |
| `tests/unit/decision/action-decider/` | Routing decisions |
| `tests/unit/runtime/context-packet/` | Slice assembly + cache |
| `tests/unit/runtime/feature-flags/` | Flag defaults |

## In-flight changes

At last verification (2026-05-28):

- Decision-engine F1 Phase 0/1 (#216, #217 — merged)
- Decision-engine harden skill-match threshold to strict `>` (#219, #223 — merged)
- Context-builder defaultResolver fixture-only (#282 → #296 — open)
- Real OperationalProfilePort wired in production-builder-set (#206 → #212 — merged)
- Knowledge_slice cache `agent_id` (#235 → #242 — open)

Verify: `gh pr list --state open --search "decision OR context-packet OR runtime"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
