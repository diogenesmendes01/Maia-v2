# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

## [3.0.0] - 2026-05-20 — "Maia v3 Runtime Architecture"

Full Runtime Architecture v3.1.1 cutover: Hot Path stages, Context Packet,
Decision Engine, Policy DSL Evaluator, Skill Abstraction, Knowledge State Machine,
Runtime Trace, Soul Layer, User Layer namespace, Identity Completion,
Admin UI v1, Calendar v2, and all P0–P11 foundation phases.

### Added

#### P0–P7 Foundation Phases
- **P0 Foundation** ([#75](https://github.com/diogenesmendes01/Maia-v2/pull/75)) — multi-tenant isolation + cognitive logging + agent runtime bootstrap
- **P1 Reflection pipeline** ([#81](https://github.com/diogenesmendes01/Maia-v2/pull/81)) — trigger → candidate → classificador → typed destination (fact/rule/procedure/gap/tool_request/discard)
- **P2 Memory + Self-model** ([#82](https://github.com/diogenesmendes01/Maia-v2/pull/82)) — 5-layer scoped memory + 3-layer self-model (domain/skill/gap) with deterministic confidence formula
- **P3a Procedure Definitions** ([#83](https://github.com/diogenesmendes01/Maia-v2/pull/83)) — declarative procedure objects + Modo ENSINO
- **P3b Procedure Runtime** ([#84](https://github.com/diogenesmendes01/Maia-v2/pull/84)) — stateful execution engine with TTL + step audit
- **P3c Procedure Governance** ([#85](https://github.com/diogenesmendes01/Maia-v2/pull/85)) — matview + reaper + step evaluator + CHECK constraints
- **P4 Operational Identity** ([#86](https://github.com/diogenesmendes01/Maia-v2/pull/86)) — 4-layer identity model (core/operational/episodic/backlog) + drift detector (7 types × 4 severities)
- **P5 Dialogical Capability Acquisition** ([#87](https://github.com/diogenesmendes01/Maia-v2/pull/87)) — Maia proposes, owner decides; 4 deterministic escalation levels (silent/dashboard/mentionable/proposed)
- **P6 Channel/Role/Policy separation** ([#88](https://github.com/diogenesmendes01/Maia-v2/pull/88)) — LLM suggests (`suggested_by`), Policy decides (`decided_by`); anti-oscillation lock + `affects_user` announcement
- **P7 Cognitive Graph orchestration** ([#90](https://github.com/diogenesmendes01/Maia-v2/pull/90)) — declarative module descriptors (runWhen/timeout/fallback/model/version) + sync/async/conditional + per-node audit + p95 budget

#### P8 Hot Path Stages
- **P8a Context Packet** ([#96](https://github.com/diogenesmendes01/Maia-v2/pull/96)) — `BaseContextPacket` → `ExecutionContextPacket` + 7 slice builders + Redis cache with TTL + invalidation bus
- **P8b Soul Layer** ([#95](https://github.com/diogenesmendes01/Maia-v2/pull/95)) — persistent behavioral biases with scope enforcement + feature-flag gating + replay-safe materialization (modulates, never blocks)
- **P8c User Layer namespace** ([#94](https://github.com/diogenesmendes01/Maia-v2/pull/94)) — fail-closed tenant boundary + agent-isolated resolvers (memory/facts/rules/hints) + JSONB `lifecycle_transitions` contract
- **P8d Identity Completion** ([#100](https://github.com/diogenesmendes01/Maia-v2/pull/100)) — operational profile v2 (4-layer) + `papel_drift` detector with feature-flag gating + `seedNewActive` atomic transition + audit precedence
- **P8e PolicyDescriptorResolver** ([#93](https://github.com/diogenesmendes01/Maia-v2/pull/93)) — single shared component for policy resolution with structured cache keys + ordered candidate fallback + fail-closed behaviour
- **P8.5 Admin UI v1** ([#101](https://github.com/diogenesmendes01/Maia-v2/pull/101)) — Next.js 14 + tRPC v11 + NextAuth v5 governance console: 5 screens (dashboard/identities/capabilities/procedures/knowledge) + approval matrix + dual founder lockdown

#### P9 Decision & Policy Layer
- **P9a Skill Abstraction** ([#99](https://github.com/diogenesmendes01/Maia-v2/pull/99)) — declarative skill artifacts + `SkillRunner` with 4 execution modes (sync/async/streaming/batch) + tenant-admin guard
- **P9b Decision Engine** ([#103](https://github.com/diogenesmendes01/Maia-v2/pull/103)) — 3 PEPs (Early/Mid/Late) + `DecisionPacket` + per-step deadline enforcement + `AbortController` integration
- **P9c Risk Scoring** ([#97](https://github.com/diogenesmendes01/Maia-v2/pull/97)) — `TurnRiskScorer` + `KnowledgeRiskScorer` with no-downgrade invariant + fail-closed LLM gate
- **P9d Policy DSL Evaluator** ([#98](https://github.com/diogenesmendes01/Maia-v2/pull/98)) — pure, total, ReDoS-safe DSL with bounded literals + order-invariant error detection + runtime fan-out caps

#### P10 Knowledge & Traceability
- **P10a Knowledge State Machine** ([#104](https://github.com/diogenesmendes01/Maia-v2/pull/104)) — 9-state lifecycle + DB-trigger transition enforcement + visibility filters + auto-promoter + `propose_*` tools
- **P10b Runtime Trace** ([#102](https://github.com/diogenesmendes01/Maia-v2/pull/102)) — sync envelope + async body with HMAC versioned keyring + redaction allowlists + matview + S3 idempotency

#### Calendar & Scheduling
- **Calendar v2** ([#105](https://github.com/diogenesmendes01/Maia-v2/pull/105)) — Brazilian holidays + business-day calendar + RRULE extension + cognitive pipeline integration
- **Scheduling v2 (Spec 18)** ([#72](https://github.com/diogenesmendes01/Maia-v2/pull/72)) — series → occurrences → tasks → outbox architecture; 7 production requirements (transactional outbox, 10k backlog drain, month-end policies, missed-run policies, cancel-race safety, multi-pending disambiguation, per-occurrence audit trail); constitutional rules C-006/C-007/C-008; 47 unit specs

#### Test Infrastructure
- `tests/fixtures/factsRepo.ts` shared mock factory ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116)) — resolves ~64 stale mock specs
- `tests/fixtures/agentProfile.ts` 4-layer profile builder ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117)) — resolves ~16 schema-mismatch specs
- `tests/fixtures/driftCandidate.ts` typed drift fixture ([#125](https://github.com/diogenesmendes01/Maia-v2/pull/125))
- `docker-compose.yml` + fail-fast integration test setup ([#123](https://github.com/diogenesmendes01/Maia-v2/pull/123))
- `tests/db/repositories-barrel.spec.ts` regression guard ([#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- Inline snapshot for `ProposalStatus` enum (7 values) ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))

### Changed
- **vitest 2.1.9 → 4.1.6** ([#120](https://github.com/diogenesmendes01/Maia-v2/pull/120)) — constructor mock arrow→function migration, `vi.mock()` hoisting via `vi.hoisted()`; 15 spec files migrated
- **@anthropic-ai/sdk 0.30.1 → 0.97.1** ([#122](https://github.com/diogenesmendes01/Maia-v2/pull/122)) — bump applied; `TextBlock.citations` required-field adjustment across 7 drift detectors ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- **@fastify/cookie 10.0.1 → 11.0.2** ([#121](https://github.com/diogenesmendes01/Maia-v2/pull/121))
- **next-auth 5.0.0-beta.25 → 5.0.0-beta.31** ([#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)) — v5 stable not yet shipped upstream
- **node-cron v3 → v4** ([#78](https://github.com/diogenesmendes01/Maia-v2/pull/78)) — API migration applied in P8–P10 batch

### Fixed
- `transitionProcedureStatus` CHECK constraint: accepts `auto_abandoned` + `human_confirmation` event types ([#92](https://github.com/diogenesmendes01/Maia-v2/pull/92))
- LLM anchor on fresh state + persisted tool results ([#74](https://github.com/diogenesmendes01/Maia-v2/pull/74))
- 4-layer AgentProfile schema mismatch in ~16 specs ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117))
- Stale `factsRepo` mocks in ~64 specs ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116))
- `TextBlock.citations` typecheck after Anthropic SDK 0.97 bump ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- `ProposalStatus` enum assertion brittleness ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))
- 8 of 11 failing specs on main post-P8–P11 integration ([#128](https://github.com/diogenesmendes01/Maia-v2/pull/128))
- WhatsApp privacy IDs (`@lid`): `pessoasRepo.findByPhone` failure + phantom send to invalid JID ([#71](https://github.com/diogenesmendes01/Maia-v2/pull/71))

### Security
- Tenant boundary fails closed when ALS context is missing (P8c, [#94](https://github.com/diogenesmendes01/Maia-v2/pull/94) round-2)
- HMAC versioned keyring for Runtime Trace (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- Capability proposals cannot self-declare low risk (P8.5, [#101](https://github.com/diogenesmendes01/Maia-v2/pull/101) round-2)
- Strict redaction with schema-driven nested allowlists for decision blobs (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- `Secure` flag added to `maia_session` cookie in production ([#58](https://github.com/diogenesmendes01/Maia-v2/pull/58))
- Stored XSS escaped in `pessoa.nome` in title/h1 ([#57](https://github.com/diogenesmendes01/Maia-v2/pull/57))

### Infrastructure
- Tech-debt issues opened and resolved: #109 drift-detector casts (resolved [#125](https://github.com/diogenesmendes01/Maia-v2/pull/125)), #110 next-auth stable (resolved [#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)), #112 docker-compose (resolved [#123](https://github.com/diogenesmendes01/Maia-v2/pull/123)), #113 capabilityProposalsRepo barrel (resolved [#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- S3/B2/R2 backup upload + cloud rotation after nightly `pg_dump` ([#65](https://github.com/diogenesmendes01/Maia-v2/pull/65))
- Per-pessoa LLM cost breakdown + per-OpenRouter-model USD pricing ([#63](https://github.com/diogenesmendes01/Maia-v2/pull/63), [#62](https://github.com/diogenesmendes01/Maia-v2/pull/62))
- `maia_db_connected` Prometheus gauge ([#61](https://github.com/diogenesmendes01/Maia-v2/pull/61))
- TS path aliases via `tsc-alias` (Coolify deploy fix) ([#67](https://github.com/diogenesmendes01/Maia-v2/pull/67))
- ESLint `no-floating-promises` (warn) on `src/` ([#64](https://github.com/diogenesmendes01/Maia-v2/pull/64))

### Known issues (open at release)
- **Production bugs tracked for follow-up**: #135 `transitionProcedureStatus` event recording, #136 contradiction TTL, #137 events-block cardinality, #138 pdfmake import
- **Runbook gaps**: #129 P8c, #130 P8.5, #131 P9b, #132 P9c
- **Admin UI**: 3 specs failing due to missing `@trpc/server` install in `src/admin-ui/`
- **next-auth**: still on beta.31 — waiting for v5 stable upstream (#110)
- **Note**: `package.json` version not yet bumped to 3.0.0 (separate concern); a `v3.0.0` git tag should be created after merge

---

### Scheduling v2 (Spec 18) — detailed notes

#### Added
- **Spec 18 v2.3 — addresses 1 follow-up BLOCKER** raised in PR #72
  review 3:
  - **B1/r3 — `claimInProgressForAdvance()` restricted to
    `recurring_outreach`**: the SQL claim now `JOIN`s on `series` and
    filters `tipo = 'recurring_outreach'`, so `one_shot_reminder`
    occurrences whose outbox row is still pending (rate-limited,
    Baileys disconnected, retry pending) are never picked up by the
    engine's in-progress pass. Previously they could be falsely
    finalized as `completed/fired` while the underlying WhatsApp
    message had never been sent. Completion for `one_shot_reminder`
    now flows exclusively through `outbox-drain`: `markSent` →
    `task.completed` → `occurrence.completed(fired)`, or `markDead`
    → `task.failed` → `occurrence.failed(reason=outbox_dead)`.

    Defence-in-depth: `advanceInProgressOccurrence` now `releaseClaim`s
    when the series tipo is not `recurring_outreach` (instead of marking
    the occurrence `completed`). Even if a future change widens the
    claim filter or a race exposes the wrong tipo, the engine never
    audits a phantom success.
- **Spec 18 v2.2 — addresses 4 follow-up BLOCKERs** raised in PR #72 review 2:
  - **B1/r2 — `payment_due` never audits confirmed on dispatch failure**:
    `resolvePaymentOccurrence` now inspects the `dispatchTool` return
    value. When the dispatcher returns `{ error: ... }` (forbidden /
    requires_dual_approval / invalid_args / etc.) OR throws, the
    occurrence is parked as `failed`, the task is marked `failed`
    with the dispatch error, the operator is alerted via the outbox,
    and the next cycle is NOT scheduled. `payment_due_confirmed`
    only audits on a real success.
  - **B2/r2 — outreach timeout anchor**: `occurrencesRepo.setStatus`
    now sets `started_at` on transitions to `awaiting_third_party`
    and `awaiting_owner` (not just `in_progress`). The
    `listAwaitingTimedOut` query relies on `started_at IS NOT NULL`
    and previously never matched any outreach occurrence.
  - **B3/r2 — forward task gated on `outbox_sent` confirmation**:
    `advanceInProgressOccurrence` enqueues the forward outbox row
    and leaves the task `in_progress`. The outbox-drain marks the
    task `completed` ONLY after a successful send. The occurrence
    finalizes (and the next cycle schedules) on the next engine tick
    that sees `forward.status='completed'`. Dead outbox rows for
    forward / fire_reminder tasks now mark the occurrence `failed`
    instead of leaving a phantom success.
  - **B4/r2 — outbox-drain loops within one cron firing**: the
    worker calls `runOutboxDrain` up to `OUTBOX_DRAIN_LOOP_PASSES`
    times (default 55), sleeping `OUTBOX_DRAIN_LOOP_SLEEP_MS` ms
    (default 1000) between passes when the rate gate denied any
    send. Honours the per-second cadence with a per-minute cron.
    Without this loop, a 10k backlog drained at ~1 msg/minute
    (rate gate denied 49 of 50 attempts per tick).
- **Spec 18 v2.1 — addresses 10 review BLOCKERs** raised on PR #72:
  - **B1 — payment_due never silently dispatches**: pending-resolver
    detects `acao_proposta.scheduling_kind === 'payment_due'` and
    routes to `resolvePaymentOccurrence`. `register_transaction`
    fires ONLY in the `sim` branch — `nao` skips and `adiar`
    postpones. Previously, the generic dispatcher would have
    executed the transaction for any chosen option.
  - **B2 — lease reclaim re-enters the pending queue**: both
    `runSchedulingTick` and `runOutboxDrain` reclaim expired leases
    by resetting rows to `pending` (clearing `claimed_by` /
    `claimed_at`). The subsequent `claimDue` in the same tick picks
    them up naturally. Previously, reclaimed rows stayed `claimed`
    indefinitely.
  - **B3 — recurring_outreach completes the cycle**: engine claims
    `in_progress` occurrences in a dedicated pass to run the
    `forward` step, scans `awaiting_third_party` for
    `wait_response_hours` timeouts and escalates, and inserts the
    next cycle via `insertNextOccurrenceIfActive`. The previous
    cycle could stall after the response was captured.
  - **B4 — engine advances are transactional**: new
    `advanceWithTx(fn)` wraps `tasks.setStatus` +
    `occurrences.setStatus` + `outbox.enqueue` inside one DB
    transaction. Either all three commit or none. Previously the
    three writes were separate calls; a crash between them left
    half-states.
  - **B5 / B6 — feature flag gates the tools**: `schedule_reminder`,
    `cancel_reminder`, `start_recurring_outreach`,
    `start_recurring_payment` only register in the LLM tool
    registry when `FEATURE_SCHEDULING_V2=true`. Prevents the LLM
    from creating series that no worker would execute.
  - **B7 — workers match the spec**: added
    `series_next_scheduler` cron (`*/10 * * * *`) that backfills
    missing next-cycle occurrences for active series whose chain
    broke (crash between complete + reschedule). Spec updated to
    document the in-tick lease reaper.
  - **B8 — exclusive_per_destinatario enforced**: when a series
    has the flag set and the engine claims an outreach occurrence,
    it checks for sibling occurrences already
    `in_progress`/`awaiting_third_party` with the same destinatario
    and defers (releases the claim with a 10-min backoff) if so.
  - **B9 — inbound hook wired**: `agent/core.ts` calls
    `captureInboundForOutreach` on every text inbound when
    scheduling is enabled. Third-party replies now actually advance
    their occurrence.
  - **B10 — integration tests for the 7 critérios**: seven specs
    under `tests/integration/scheduling/` exercise crash recovery,
    backlog drain under backpressure, month-end policy outcomes,
    missed-run policy decisions, cancel-race, multi-pending
    disambiguation, and per-occurrence audit reconstruction.
- **Spec 18 v2 — Scheduling: series → occurrences → tasks → outbox**
  (`docs/specs/18-scheduling-and-recurring-workflows.md`). Operational
  engineering spec for proactive scheduling. Supersedes the v1
  discovery draft. Satisfies seven production requirements:
  1. Outbox never loses a message — transactional outbox table.
  2. 10k-deep backlog drains under per-second + per-hour + per-
     recipient backpressure (`OUTBOX_MAX_*` env).
  3. Monthly series on day 31 follows a documented
     `month_end_policy` (`skip_invalid_month` | `last_day_of_month`
     | `nearest_previous` | `nearest_next`).
  4. Multi-day downtime follows a documented `missed_run_policy`
     (`fire_all` | `fire_latest_only` | `skip_all` |
     `escalate_to_owner`).
  5. Cancelling a series prevents new occurrences even with a
     concurrent engine tick — version-gated INSERT + atomic
     status+occurrence transaction.
  6. Multiple open outreaches with the same destinatario never
     capture each other's response — correlation tokens
     (`_ref: A4F2_`) + disambiguation prompt to the owner.
  7. Every occurrence has an auditable trail from scheduling to
     final outcome in **one SQL query** — `audit_log.occurrence_id`
     populated on every state transition.
- **Migration `007_scheduling.sql`**: four new tables
  (`series`, `occurrences`, `tasks`, `outbox_messages`) +
  `audit_log.occurrence_id`. All indexes for hot paths.
- **`src/scheduling/`** module: `rrule.ts` (RFC 5545 subset +
  month-end policies), `repos.ts` (transactional repos with
  `FOR UPDATE SKIP LOCKED` and optimistic locking),
  `backpressure.ts` (Redis token-bucket per-second/per-hour +
  per-recipient pacing, fail-CLOSED on Redis outage),
  `correlation.ts` (4-hex tokens for outreach disambiguation),
  `policies.ts` (missed-run decision table),
  `disambiguation.ts` (multi-pending owner prompt),
  `engine.ts` (claim + advance per-tipo, never sends directly),
  `outbox-drain.ts` (lease-based claim, polynomial backoff, DLQ).
- **New tools**:
  - `schedule_reminder` (rewritten) — creates a `one_shot_reminder`
    series + initial occurrence + reminder task atomically.
  - `cancel_reminder` (rewritten) — invokes
    `seriesRepo.cancelAtomic` so cancellation pre-empts in-flight
    engine ticks.
  - `start_recurring_outreach` (new) — `recurring_outreach` series
    with C-007 dual-approval gate at creation.
  - `start_recurring_payment` (new) — `recurring_payment` series
    with C-006 hard-limit gate at creation.
- **New workers**: `scheduling_tick` (cron `* * * * *`) and
  `outbox_drain` (cron `* * * * *`). Both register only when
  `FEATURE_SCHEDULING_V2=true`.
- **Constitutional rules**: **C-006** (`start_recurring_payment`
  above `VALOR_LIMITE_DURO` rejected), **C-007**
  (`start_recurring_outreach` requires `dual_approval_granted`),
  **C-008** (defence-in-depth — occurrence rejected at claim if
  `contexto_snapshot.valor` exceeds current `VALOR_LIMITE_DURO`).
- **Env vars**: `FEATURE_SCHEDULING_V2`, `OUTBOX_MAX_PER_SECOND`
  (default 1), `OUTBOX_MAX_PER_HOUR` (default 600),
  `OUTBOX_WORKER_CONCURRENCY` (default 4),
  `OUTBOX_LEASE_TTL_SECONDS` (default 300),
  `OCCURRENCE_LEASE_TTL_SECONDS` (default 300).
- **23 new audit actions** covering series, occurrence, outbox,
  outreach, payment_due lifecycles.
- **47 new unit specs** across 8 files, one per requirement
  (rrule, policies, correlation, backpressure, disambiguation,
  cancel-race, outbox-drain, engine).

## [0.1.0] - 2026-04-27

### Added
- Estrutura inicial do projeto (Node 20 + TypeScript)
- Documentação de arquitetura completa (`docs/arquitetura.md`)
- Schema do banco com 16 tabelas (PostgreSQL 16 + pgvector)
- System prompt da Maia v0 (`src/identity/maia-prompt.md`)
- Template de inventário para preencher (`docs/inventario.md`)
- Docker Compose com Postgres + pgvector + Redis
- Configuração TypeScript strict mode
- `.env.example` documentado
- Licença MIT
