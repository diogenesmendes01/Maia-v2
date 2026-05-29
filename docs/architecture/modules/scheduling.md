# scheduling

**Path:** `src/scheduling/`

**Purpose** — Series → occurrences → tasks → outbox architecture for high-stakes recurring workflows (payments, reminders, recurring outreach). A series is a recurrence rule (RRule); occurrences materialize from the series; tasks are the actionable jobs; the outbox guarantees at-least-once dispatch under crash. Business-day-aware (Brazilian holidays). Designed to survive process crashes without losing or double-sending occurrences.

## Key files

| File | Role |
|---|---|
| `src/scheduling/engine.ts` | Operational engine: drives transitions, schedules next occurrences |
| `src/scheduling/repos.ts` | Tenant-scoped persistence for series, occurrences, tasks, outbox |
| `src/scheduling/policies.ts` | Month-end policies, missed-run policies, day-of-week adjustments |
| `src/scheduling/rrule.ts` | RRule expansion |
| `src/scheduling/business-day-rrule.ts` | Business-day-aware recurrence |
| `src/scheduling/outbox-drain.ts` | Transactional outbox drain — at-least-once dispatch with idempotency |
| `src/scheduling/backpressure.ts` | Backpressure on outbox (10k backlog drain pattern) |
| `src/scheduling/correlation.ts` | Correlates occurrences across reschedules |
| `src/scheduling/disambiguation.ts` | Multi-pending disambiguation |
| `src/scheduling/types.ts` | Shared types |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — every row scopes by `tenant_id + agent_id`
- [Governance + observability](../concerns/governance-observability.md) — per-occurrence audit trail; double-send guarded by outbox + idempotency
- [Action layer](../concerns/action-layer.md) — outbox dispatch goes through tools with idempotency keys

## How to extend

| Need | Where |
|---|---|
| Add a new recurrence pattern | Extend `rrule.ts` or `business-day-rrule.ts`; cover with property tests |
| Add a new policy (e.g., quarter-end) | Extend `policies.ts`; document trigger conditions |
| Add a new outbox consumer | The outbox-drain worker reads `outbox`; consumers register via task type |
| Change backpressure | `backpressure.ts` — adjust thresholds; respect 10k drain SLO |

## Public surface

| Consumed by | What |
|---|---|
| `src/tools/start-recurring-payment.ts`, `start-recurring-outreach.ts`, `schedule-reminder.ts`, `cancel-reminder.ts` | LLM-callable scheduling tools |
| `src/workers/scheduling-tick.ts` | Tick worker drives engine |
| `src/workers/series-next-scheduler.ts` | Schedules next occurrence per series |
| `src/workers/outbox-drain-worker.ts` | Drains outbox to dispatch |

## Tests

| Test path | What it covers |
|---|---|
| `tests/integration/scheduling/01-outbox-crash-no-loss.spec.ts` | Crash recovery |
| `tests/integration/scheduling/02-backpressure-10k-drain.spec.ts` | 10k backlog drain |
| `tests/integration/scheduling/03-month-end-policy.spec.ts` | Month-end policy |
| `tests/integration/scheduling/04-missed-run-policy.spec.ts` | Missed-run policy |
| `tests/integration/scheduling/05-cancel-race.spec.ts` | Cancel-race safety |
| `tests/integration/scheduling/06-multi-pending-disambiguation.spec.ts` | Multi-pending |
| `tests/integration/scheduling/07-audit-trail-per-occurrence.spec.ts` | Per-occurrence audit |

## In-flight changes

At last verification (2026-05-28):

- Outbound idempotency ledger to close double-send window (#227 → #233 — merged)
- Embeddings rebuild validation (touches scheduled embedding refresh) (#289 → #295 — open)

Verify: `gh pr list --state open --search "scheduling OR outbox OR rrule"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
