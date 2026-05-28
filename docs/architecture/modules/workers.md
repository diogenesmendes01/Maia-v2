# workers

**Path:** `src/workers/`

**Purpose** — 33 background workers driven by cron and BullMQ. Each worker has one job: refresh a materialized view, drain a queue, reap zombies, monitor a budget, write a trace body, promote a knowledge state, etc. Workers enter `runWithTenantContext` per tenant (iteration, not a single global pass) and emit metrics + audit per iteration.

## Key files

| File | Role |
|---|---|
| `src/workers/index.ts` | Worker registry and startup orchestration |

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
