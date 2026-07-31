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

### Turn state machine (`src/runtime/turns/`) — issue #503

Máquina de estados **durável** do turno inbound. PostgreSQL é a fonte de verdade
do ciclo de vida; Redis/BullMQ são só wake-up e distribuição. Um turno é
**lógico**: agrega N mensagens inbound (debounce) numa única execução.

| File | Role |
|---|---|
| `contract.ts` | Vocabulário PURO: estados, outcomes, tabela de transições, compatibilidade estado/outcome, sanitização do erro persistido. Sem I/O — unit-testável sem Postgres. |
| `lifecycle.ts` | Fachada usada por gateway/agent/workers: flag de rollout, fail-soft, auditoria e métricas. |
| `index.ts` | Superfície pública — importe daqui. |

A **única porta de escrita** é `agentTurnsRepo`
([`src/db/repositories/turn-repos.ts`](../../../src/db/repositories/turn-repos.ts)):
nenhum caller atualiza `status` direto e toda transição é compare-and-swap sobre
`state_version`, escopada por `tenant_id + agent_id`.

**Estados** — `received → queued → claimed → running → outbound_pending →
completed`, com `retryable` (falha antes de efeito irreversível), `ignored`
(descarte por regra explícita), `superseded` (absorvido pelo debounce) e
`dead_letter`. `outbound_pending` **nunca** volta para `running`; estado
terminal **sempre** carrega outcome.

**Outcome ≠ estado**: o caller declara o RESULTADO DE NEGÓCIO
(`reply_delivered`, `identity_unknown`, `rate_limited_silent`, …) e a fachada
deriva o estado terminal. É assim que "nenhum turno é concluído simplesmente
porque uma função retornou" fica garantido.

**Rollout** — duas flags, registradas em `ENV_CONTRACT`
([`src/config/contract.ts`](../../../src/config/contract.ts)) e documentadas em
[`docs/configuration.md`](../../configuration.md) (arquivo **gerado**; edite o
contrato, nunca o `.env.example`):

| Flag | Default | Efeito |
|---|---|---|
| `FEATURE_TURN_STATE_MACHINE` | `true` | Dual-write: cria/transiciona turnos. Só ESCRITA — o comportamento observável não muda. **Exige as migrations 096/097 aplicadas.** |
| `FEATURE_TURN_STATE_AUTHORITATIVE` | `false` | Flip da LEITURA: o recovery elege por `agent_turns.status` em vez de `processada_em`. |

A combinação `AUTHORITATIVE=true` + `MACHINE=false` é inerte e por isso o boot a
**recusa** (regra `turn-state/authoritative-requires-dual-write` em
[`src/config/rules.ts`](../../../src/config/rules.ts)).

Enquanto a segunda flag estiver OFF, `mensagens.processada_em` continua sendo a
decisão de negócio e a máquina roda em **shadow**; a divergência é medida por
`maia_turn_legacy_projection_mismatch_total`. Runbook:
[`docs/runbooks/turn-state-machine.md`](../../runbooks/turn-state-machine.md).

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
| `roles.ts` | **Process role contract** — `ProcessRole`, `LifecycleComponent`, `JobGroup`, `ROLE_CONTRACTS`, `roleOwns()`, `roleRequires()`, `roleRunsJobGroup()`. What a role STARTS, what gates its readiness, and which cron groups it runs. Consumed by `src/index.ts` and `src/workers/index.ts`; the deployment side is `compose.roles.yml` (issue #513). |
| `controller.ts` | Singleton state machine: legal transitions, component registry, idempotent shutdown with an ordered step list + deadline, `isAcceptingWork()` (the "no new work" gate), abortable startup (`runStartupStep`), background-task registry, `maia_lifecycle_state` gauge |
| `shutdown-sequence.ts` | The ordered steps and the signal handlers. Order is the contract: stop accepting work → drain crons → drain BullMQ → drain background tasks → close the turn-context subscriber (#511, its own ioredis connection) → close sessions → HTTP → audit → pools |
| `readiness.ts` | Composite, role-aware `/readyz` + `/startupz` evaluation. Read-only, per-component timeout, memoized, sanitized output |
| `schema-version.ts` | Applied-vs-expected migration comparison. Validates only — never applies |
| `index.ts` | Public barrel (import the role contract from here) |

#### Topology separation (issue #513)

The role contract has **two axes**, and conflating them is what made a real
split break silently:

- `owns` / `requires` — which lifecycle COMPONENTS the process starts and
  which ones gate `/readyz`.
- `jobGroups` — which cron GROUPS the process is responsible for. Deliberately
  not derived from `owns`: `session-owner` owns `cron_scheduler` (it needs the
  machinery for the #518 pairing bridge, whose every effect reaches the
  in-process Baileys socket map) but is not responsible for maintenance. Derive
  the group from ownership and every sweeper fires N+1 times in a split deploy.

Deployment: `compose.prod.yml` is the single-process topology
(`MAIA_PROCESS_ROLE=all`); `compose.roles.yml` is one container per role. They
are alternatives, never overlays — combining them runs the monolith alongside
the roles.

Rules this module enforces:

- readiness is impossible outside `ready`, and turns 503 on the first request after a drain starts — the state is checked before AND after the probes, so a drain that begins mid-probe still answers not-ready;
- **no new work after `draining`**: BullMQ workers are paused in the first shutdown step, the processor re-parks a job handed to it during the race, cron ticks are refused, and Baileys reconnect timers are cancelled instead of awaited;
- the STARTUP is cancellable too — a signal mid-boot aborts at the next phase boundary and the shutdown waits for the phase in flight (and records `startup:<phase>` as undrained if that wait expires, which forces a non-zero exit);
- the boot does not declare `ready` — nor audit `system_started`, nor let `/startupz` pass — until every component the ROLE requires is genuinely up, including the first WhatsApp `open` (`waitForComponent`);
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
| `tests/unit/runtime/lifecycle-roles.spec.ts` | Process role contract + job-group invariants (#512/#513) |
| `tests/unit/workers/job-role-inventory.spec.ts` | Cron registry filtered by role; roles cover the registry with no gap and no overlap (#513) |
| `tests/unit/runtime/lifecycle-controller.spec.ts` | State machine, idempotent shutdown, drain deadline |
| `tests/unit/runtime/lifecycle-readiness.spec.ts` | Role-aware `/readyz` + `/startupz` fail-closed cases |
| `tests/unit/runtime/lifecycle-schema-version.spec.ts` | Migration version gate |
| `tests/unit/runtime/lifecycle-shutdown-order.spec.ts` | Shutdown step ORDER as a contract |
| `tests/unit/runtime/lifecycle-startup-abort.spec.ts` | Signal mid-boot: cancellation + serialization |
| `tests/unit/runtime/lifecycle-whatsapp-readiness.spec.ts` | Never-established vs reconnecting |
| `tests/unit/runtime/lifecycle-wait-for-component.spec.ts` | `ready`/`system_started`/`/startupz` gated on the first `open` |
| `tests/unit/runtime/lifecycle-background-tasks-wired.spec.ts` | The drain observes real fire-and-forget work |
| `tests/unit/gateway/queue-drain-guard.spec.ts` | No job starts after draining |
| `tests/unit/gateway/queue-await-ready.spec.ts` | `waitUntilReady` before claiming ready |
| `tests/integration/lifecycle-probes.spec.ts` | Probes against real Postgres/Redis; `/health` writes no rows |
| `tests/integration/lifecycle-drain-queue.spec.ts` | Real Redis: job enqueued during the drain never runs |
| `tests/unit/turn-state-machine.spec.ts` | Tabela completa de transições válidas/inválidas, outcome obrigatório em terminal, sanitização do erro |
| `tests/unit/turn-lifecycle.spec.ts` | Kill switch, derivação outcome→estado, retry/dead letter, fail-soft |
| `tests/integration/agent-turns-real-db.spec.ts` | CAS concorrente, FK composta, projeção legada, backfill idempotente, plano do índice |
| `tests/integration/agent-turns-leak.spec.ts` | Leak cross-tenant do `agentTurnsRepo` (parte de `npm run test:leak`) |

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
