# workers

**Path:** `src/workers/`

**Purpose** — 33 background workers driven by cron and BullMQ. Each worker has one job: refresh a materialized view, drain a queue, reap zombies, monitor a budget, write a trace body, promote a knowledge state, etc. Workers enter `runWithTenantContext` per tenant (iteration, not a single global pass) and emit metrics + audit per iteration.

## Key files

| File | Role |
|---|---|
| `src/workers/index.ts` | Worker registry, startup orchestration and the cron **drain** (`stopWorkers`) |

### Cron drain and overlap (issue #512)

`startWorkers()` wraps every tick in a guard (`runTick`) that:

- **refuses new ticks once the drain started** — no side effect begins after `draining`;
- **skips a job whose previous run is still active** (`maia_worker_tick_skipped_total{worker,reason="overlap"}`). Every long-running job here is already single-flight via a DB lease, so skipping beats racing;
- tracks the in-flight promise so `stopWorkers(deadlineMs)` can **await** it.

`stopWorkers()` is `async` and returns `{ drained, pending }`. `pending` is the
honest list of jobs still executing when the deadline expired — it is logged
(`worker.drain_deadline_exceeded`) and surfaces in the shutdown outcome. Before
#512 it was a synchronous `task.stop()` loop, so `gracefulShutdown()` closed
the Redis/Postgres pools underneath a running cron.

Per-worker gauges: `maia_worker_active_jobs{worker}`,
`maia_worker_last_success_timestamp{worker}`,
`maia_worker_last_failure_timestamp{worker}`.

`health_monitor` also owns the **persistence** of the health timeline
(`recordHealthSnapshot`) since #512 — `/health` itself no longer writes.

### Worker categories

| Category | Files |
|---|---|
| **Reflection + cognition** | `reflection-batch.ts`, `confidence-recompute.ts`, `pattern-detector.ts`, `behavioral-hint-validator.ts`, `soul-bias-activator.ts`, `legacy-memory-reclassifier.ts` |
| **Knowledge state machine** | `knowledge-state-promoter.ts` |
| **Procedures** | `procedure-execution-reaper.ts`, `procedure-candidate-consumer.ts`, `procedure-metrics-refresh.ts` |
| **Drift + escalation** | `drift-monitor.ts`, `gap-escalation-monitor.ts` |
| **Scheduling** | `scheduling-tick.ts`, `series-next-scheduler.ts`, `outbox-drain-worker.ts` |
| **Pending questions** | `pending-expirer.ts`, `pending-reminder.ts` |
| **Trace (P10b)** | `trace-body-writer.ts`, `trace-body-recoverer.ts`, `trace-matview-refresh.ts` |
| **Conversation** | `conversation-summarizer.ts`, `inactivity-sweep.ts`, `message-recovery.ts` |
| **Briefings** | `briefings.ts` |
| **Governance** | `audit-mode-expirer.ts`, `audit-watcher.ts`, `idempotency-cleanup.ts` |
| **Onboarding (#519)** | `onboarding-expirer.ts` — varredura GLOBAL sob contexto `system` (a run vencida pode ainda não ter tenant), em lotes de `ONBOARDING_EXPIRER_BATCH_LIMIT`. A série de cancelamento é atribuída ao `tenant_id + agent_id` de cada run; o backlog é lido no scrape (`observability/onboarding-expiry-collector.ts`), não publicado pelo worker. Ver o cabeçalho do arquivo |
| **Operational** | `health-monitor.ts`, `cost-monitor.ts`, `dlq-monitor.ts`, `backup.ts`, `backup-s3.ts` |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — workers iterate per tenant via `runWithTenantContext`, never with a single global query
- [Governance + observability](../concerns/governance-observability.md) — every worker emits metrics with `tenant_id + agent_id` labels and audits its work
- One job per worker; complex flows split across multiple workers connected via queues or matviews

## How to extend

| Need | Where |
|---|---|
| Add a new worker | New file `src/workers/<name>.ts`; register in `index.ts`; declare cron/queue trigger; iterate per tenant via `runWithTenantContext` |
| Change a worker's schedule | Edit its cron expression in `index.ts` |
| Add backpressure / batch limits | Per-worker config; document in the relevant runbook |
| Recover from a worker crash | Workers are restartable; DLQ catches failures (`dlq-monitor.ts` surfaces) |

## Public surface

Workers are leaves of the architecture — they import from many modules but are imported by nothing (except `index.ts`).

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/workers/` | Per-worker contracts |
| `tests/integration/workers/` | Workers against real Postgres/Redis |
| `tests/integration/p10a-knowledge-lifecycle.spec.ts` | `knowledge-state-promoter` lifecycle |

## In-flight changes

At last verification (2026-05-28):

- KSM promoter per-row context wraps audit (#255 → #280 — open)
- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)
- Reflection-batch per-tenant context iteration (#240 → #251 — merged)

Verify: `gh pr list --state open --search "worker OR promoter OR reaper"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
