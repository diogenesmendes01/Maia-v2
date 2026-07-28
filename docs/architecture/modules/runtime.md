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

### Lifecycle (`src/runtime/lifecycle/`) — issue #512

Process-level (not per-turn) infrastructure: the explicit `starting → ready →
draining → stopped ↘ failed` state machine, role-aware readiness and the
ordered graceful shutdown. `src/index.ts` drives it; `src/server.ts` exposes it
through `/livez`, `/startupz` and `/readyz`.

| File | Role |
|---|---|
| `roles.ts` | **Process role contract** — `ProcessRole`, `LifecycleComponent`, `ROLE_CONTRACTS`, `roleOwns()`, `roleRequires()`. What a role STARTS vs what gates its readiness. Consumed by issue #513 (topology separation). |
| `controller.ts` | Singleton state machine: legal transitions, component registry, idempotent shutdown with an ordered step list + deadline, `isAcceptingWork()` (the "no new work" gate), abortable startup (`runStartupStep`), background-task registry, `maia_lifecycle_state` gauge |
| `shutdown-sequence.ts` | The ordered steps and the signal handlers. Order is the contract: stop accepting work → drain crons → drain BullMQ → drain background tasks → close sessions → HTTP → audit → pools |
| `readiness.ts` | Composite, role-aware `/readyz` + `/startupz` evaluation. Read-only, per-component timeout, memoized, sanitized output |
| `schema-version.ts` | Applied-vs-expected migration comparison. Validates only — never applies |
| `index.ts` | Public barrel (import the role contract from here) |

Rules this module enforces:

- readiness is impossible outside `ready`, and turns 503 on the first request after a drain starts — the state is checked before AND after the probes, so a drain that begins mid-probe still answers not-ready;
- **no new work after `draining`**: BullMQ workers are paused in the first shutdown step, the processor re-parks a job handed to it during the race, cron ticks are refused, and Baileys reconnect timers are cancelled instead of awaited;
- the STARTUP is cancellable too — a signal mid-boot aborts at the next phase boundary and the shutdown waits for the phase in flight;
- a required component that is `down`/`unknown` keeps the instance out of rotation (fail-closed);
- probes never write and never return raw driver text;
- shutdown is idempotent — concurrent signals share one promise — and closes consumers before the pools they use;
- undrained components are reported (log + `maia_shutdown_total{result="incomplete"}`), never silently dropped.

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
| `tests/unit/runtime/lifecycle-roles.spec.ts` | Process role contract (#512/#513) |
| `tests/unit/runtime/lifecycle-controller.spec.ts` | State machine, idempotent shutdown, drain deadline |
| `tests/unit/runtime/lifecycle-readiness.spec.ts` | Role-aware `/readyz` + `/startupz` fail-closed cases |
| `tests/unit/runtime/lifecycle-schema-version.spec.ts` | Migration version gate |
| `tests/unit/runtime/lifecycle-shutdown-order.spec.ts` | Shutdown step ORDER as a contract |
| `tests/unit/runtime/lifecycle-startup-abort.spec.ts` | Signal mid-boot: cancellation + serialization |
| `tests/unit/runtime/lifecycle-whatsapp-readiness.spec.ts` | Never-established vs reconnecting |
| `tests/unit/runtime/lifecycle-background-tasks-wired.spec.ts` | The drain observes real fire-and-forget work |
| `tests/unit/gateway/queue-drain-guard.spec.ts` | No job starts after draining |
| `tests/unit/gateway/queue-await-ready.spec.ts` | `waitUntilReady` before claiming ready |
| `tests/integration/lifecycle-probes.spec.ts` | Probes against real Postgres/Redis; `/health` writes no rows |
| `tests/integration/lifecycle-drain-queue.spec.ts` | Real Redis: job enqueued during the drain never runs |

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
