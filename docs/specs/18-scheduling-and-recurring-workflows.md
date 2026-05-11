# Spec 18 — Scheduling: Series, Occurrences, Outbox, Operational Engine

**Status:** Production engineering spec • **Depends on:** 00, 02, 06, 07, 09, 11, 12, 17

> Supersedes the discovery draft of spec 18. Recurring scheduling and payment confirmations are high-stakes workflows that must survive crash, partial network failure, multi-day downtime, concurrent workers, and operator cancellation. This spec defines **how** that happens, not just **what** the feature looks like.

---

## 1. Purpose

A durable, observable, reversible scheduler for Maia that satisfies seven operational requirements:

| # | Requirement |
|---|---|
| 1 | Outbox never loses a message — atomicity between DB commit and WhatsApp send |
| 2 | A 10k-deep backlog drains under controlled backpressure without WhatsApp ban |
| 3 | Monthly series on day 31 follows a **documented**, configurable policy |
| 4 | After multi-day downtime, behaviour follows a **documented** `missed_run_policy` |
| 5 | Cancelling a series prevents new occurrences even with a concurrent engine tick |
| 6 | Multiple open pendings with the same third party never capture each other's reply |
| 7 | Every occurrence has an auditable trail from scheduling to final outcome in **one query** |

Anything that violates any of these is a bug, not a design tradeoff.

## 2. Goals

- Single conceptual model — **Series → Occurrences → Tasks → Outbox** — covering one-shot reminders, recurring outreach, recurring payments, and any future scheduled action.
- Postgres is the source of truth; Redis is a cache for rate-limit counters.
- Workers are stateless and horizontally idempotent (`FOR UPDATE SKIP LOCKED` + claim/lease).
- Every state transition writes audit; one occurrence = one canonical query.

## 3. Non-goals

- Sub-minute precision (60s tick remains the contract).
- Multi-tenant isolation (single-tenant per spec 00).
- Arbitrary user-supplied cron syntax (we expose a minimal RRULE subset).
- Cross-region replication.

## 4. Domain model

Four new tables. The existing `workflows` table stays untouched for `dual_approval` and free-form workflows; recurring scheduling lives entirely in the new tables to avoid the dual-purpose ambiguity that broke the v1 design.

### 4.1 `series`

The recurring (or one-shot) template.

```sql
CREATE TABLE series (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                        TEXT NOT NULL,                 -- 'one_shot_reminder' | 'recurring_outreach' | 'recurring_payment'
  status                      TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'cancelled'
  version                     INTEGER NOT NULL DEFAULT 1,    -- optimistic lock against concurrent inserts
  rrule                       TEXT,                          -- NULL for one_shot_reminder
  one_shot_at                 TIMESTAMPTZ,                   -- non-null only for one_shot_reminder
  month_end_policy            TEXT NOT NULL DEFAULT 'skip_invalid_month',
                              -- 'skip_invalid_month' | 'last_day_of_month' | 'nearest_previous' | 'nearest_next'
  missed_run_policy           TEXT NOT NULL DEFAULT 'fire_latest_only',
                              -- 'fire_all' | 'fire_latest_only' | 'skip_all' | 'escalate_to_owner'
  staleness_threshold_hours   INTEGER NOT NULL DEFAULT 24,   -- past this, an unfired occurrence ages out
  exclusive_per_destinatario  BOOLEAN NOT NULL DEFAULT FALSE,
  contexto_template           JSONB NOT NULL DEFAULT '{}',   -- payment details, message template, etc.
  entidade_id                 UUID,
  owner_pessoa_id             UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at                TIMESTAMPTZ,
  CHECK (
    (tipo = 'one_shot_reminder' AND one_shot_at IS NOT NULL AND rrule IS NULL) OR
    (tipo <> 'one_shot_reminder' AND rrule IS NOT NULL AND one_shot_at IS NULL)
  )
);

CREATE INDEX idx_series_active ON series (owner_pessoa_id) WHERE status = 'active';
```

### 4.2 `occurrences`

Each scheduled fire. **Idempotent**: a series can never have two occurrences at the same `scheduled_for` (UNIQUE constraint), so duplicate inserts during a race are rejected at the DB layer.

```sql
CREATE TABLE occurrences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id           UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  scheduled_for       TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
                      -- 'pending'|'claimed'|'in_progress'|'awaiting_third_party'|'awaiting_owner'
                      -- |'completed'|'skipped'|'failed'|'aged_out'|'cancelled'
  outcome             TEXT,        -- 'sim'|'nao'|'adiar'|'no_response'|'fired'|'forwarded'|null
  claimed_by          TEXT,        -- worker id (host + pid + uuid)
  claimed_at          TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  correlation_token   TEXT,        -- 4-hex string embedded in outbound message (recurring_outreach)
  contexto_snapshot   JSONB NOT NULL DEFAULT '{}',
                      -- frozen copy of series.contexto_template at creation time
                      -- ensures running occurrences survive series edits
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_id, scheduled_for)
);

CREATE INDEX idx_occurrences_due
  ON occurrences (scheduled_for)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX idx_occurrences_series
  ON occurrences (series_id, status);

CREATE INDEX idx_occurrences_corr
  ON occurrences (correlation_token)
  WHERE correlation_token IS NOT NULL AND status IN ('awaiting_third_party', 'in_progress');
```

### 4.3 `tasks`

Steps within one occurrence. Replaces `workflow_steps` for the scheduling domain (the old table remains for legacy workflow types).

```sql
CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id   UUID NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  ordem           INTEGER NOT NULL,
  kind            TEXT NOT NULL,
                  -- 'fire_reminder'|'send_outreach'|'await_response'|'forward'
                  -- |'propose_payment'|'await_decision'|'execute_or_skip'
  status          TEXT NOT NULL DEFAULT 'pending',
                  -- 'pending'|'in_progress'|'completed'|'skipped'|'failed'
  result          JSONB NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (occurrence_id, ordem)
);
```

### 4.4 `outbox_messages`

The transactional outbox. Anything that must reach the outside world (WhatsApp text, poll, document, alert email) is enqueued **in the same transaction** that advances the task state. A separate worker drains it.

```sql
CREATE TABLE outbox_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id     UUID REFERENCES occurrences(id) ON DELETE SET NULL,
  task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
                    -- 'whatsapp_text'|'whatsapp_pending_question'|'whatsapp_alert'|'email_alert'
  payload           JSONB NOT NULL,        -- { jid, text } or { pessoa_id, conversa_id, question_payload } etc.
  status            TEXT NOT NULL DEFAULT 'pending',
                    -- 'pending'|'claimed'|'sent'|'failed'|'dead'
  claimed_by        TEXT,
  claimed_at        TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  sent_at           TIMESTAMPTZ,
  dedup_key         TEXT,                  -- optional caller-supplied unique key
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_due
  ON outbox_messages (next_attempt_at)
  WHERE status IN ('pending', 'claimed');

CREATE UNIQUE INDEX idx_outbox_dedup
  ON outbox_messages (dedup_key)
  WHERE dedup_key IS NOT NULL;
```

### 4.5 `audit_log` extension

Existing `audit_log` gets one new column. No data migration needed; back-fill is unnecessary because the column is nullable and only used by new flows.

```sql
ALTER TABLE audit_log ADD COLUMN occurrence_id UUID REFERENCES occurrences(id) ON DELETE SET NULL;
CREATE INDEX idx_audit_log_occurrence ON audit_log (occurrence_id) WHERE occurrence_id IS NOT NULL;
```

## 5. State machines

### 5.1 Occurrence lifecycle

```
            ┌──────────────────────────────────────────┐
            ▼                                          │
pending ─► claimed ─► in_progress ──► completed        │
   │           │            │                          │
   │           │            ├──► awaiting_third_party ─┤ (response arrives or ages out)
   │           │            │
   │           │            ├──► awaiting_owner ────────► completed | skipped | failed
   │           │            │
   │           │            └──► failed
   │           │
   │           └──► (re-claim on lease expiry → claimed)
   │
   ├──► cancelled    (via cancel_series)
   └──► aged_out     (past staleness_threshold_hours)
```

A claim is a **lease**: `claimed` rows with `claimed_at < now() - LEASE_TTL` are reclaimable by another worker. Default lease = 5 minutes.

### 5.2 Outbox lifecycle

```
pending ─► claimed ─► sent
   │           │
   │           └──► failed (attempts < max) ─► back to pending with backoff
   │
   └─► dead  (attempts >= max)   alerts operator, never auto-retries
```

## 6. Policies

All policies are **persisted on the series row** and applied in deterministic code paths. None is implicit.

### 6.1 `month_end_policy`

Applied by `computeNextOccurrence(series, after)` whenever `rrule` has `BYMONTHDAY` and the target month does not contain that day.

| Value | Behaviour for `BYMONTHDAY=31` in February |
|---|---|
| `skip_invalid_month` | Skips February entirely; next fire is March 31. (default) |
| `last_day_of_month` | Fires on Feb 28 / 29. |
| `nearest_previous` | Fires on Feb 28. Same as `last_day_of_month` for end-of-month; different for `BYMONTHDAY=30` in Feb (29 vs 28). |
| `nearest_next` | Fires on Mar 1. |

### 6.2 `missed_run_policy`

Applied by the engine tick when it discovers an occurrence with `scheduled_for < now() - staleness_threshold_hours`.

| Value | Behaviour |
|---|---|
| `fire_all` | Fire every overdue occurrence in chronological order. Default for `one_shot_reminder` (a missed lembrete is still a useful lembrete late). |
| `fire_latest_only` | Audit older overdues as `occurrence_aged_skipped`; fire only the most recent. Default for `recurring_payment` and `recurring_outreach`. |
| `skip_all` | Audit each overdue as `occurrence_aged_skipped`; engine schedules only the next future occurrence. |
| `escalate_to_owner` | Audit overdues; do not fire; send an alert message to the owner asking how to proceed. |

`staleness_threshold_hours` controls when an occurrence becomes "overdue" for this policy. Default 24h. A 25-minute hiccup never triggers policy logic — only multi-hour windows.

### 6.3 `staleness_threshold_hours`

Past this window an unfired occurrence is `aged_out` regardless of policy when the missed-run policy is `skip_all` or `escalate_to_owner`. For `fire_all` and `fire_latest_only`, the policy itself decides — staleness controls *whether the policy even applies*. Threshold is independently overridable per series.

### 6.4 `exclusive_per_destinatario`

When true, the engine refuses to create a new occurrence for the series while a prior occurrence with the same `contexto_snapshot.destinatario_pessoa_id` is in `awaiting_third_party` or `in_progress`. The previous one must complete or age out first. Prevents pile-up of un-answered outreach to the same person.

## 7. Operational mechanics

### 7.1 Outbox-first writes (Requirement 1)

Every code path that needs to reach WhatsApp follows the **same** contract:

```typescript
await db.transaction(async (tx) => {
  await tx.update(tasks).set({ status: 'completed', result }).where(...);
  await tx.insert(outbox_messages).values({
    occurrence_id, task_id,
    kind: 'whatsapp_text',
    payload: { jid, text, ... },
    dedup_key: `${occurrence_id}:${task.ordem}:send`,
  });
});
```

If the process crashes after the commit, the next `outbox-drain` tick picks up the pending row. If the process crashes before the commit, neither the state advance nor the outbox row exists. **No half-states.**

The `dedup_key` is required for every outbox write that could be retried. Format: `<occurrence_id>:<task_ordem>:<purpose>`. The unique partial index rejects duplicates at the DB layer, so retrying the whole transaction is safe.

### 7.2 Backpressure (Requirement 2)

Three independent limits applied by `outbox-drain`:

1. **Global rate** — Redis token bucket at key `outbox:rate:whatsapp`, refilled by config:
   - `OUTBOX_MAX_PER_SECOND` (default 1)
   - `OUTBOX_MAX_PER_HOUR` (default 600)
2. **Per-recipient pacing** — `SET NX EX 2` on `outbox:pace:{jid}` before send; if the key exists, defer (occurrence remains `pending` for next tick).
3. **Concurrency** — at most `OUTBOX_WORKER_CONCURRENCY` (default 4) in-flight sends per drain pass.

A 10k backlog with default config drains at 1 msg/s = ~2.8 hours, but more importantly it never bursts to WhatsApp. If `OUTBOX_MAX_PER_HOUR` is exceeded, drain waits.

To honour the per-second cadence with a per-minute cron, the worker
loops within a single firing: each pass calls `runOutboxDrain`, then
sleeps `OUTBOX_DRAIN_LOOP_SLEEP_MS` (default 1000ms) when the rate
gate denied any send, up to `OUTBOX_DRAIN_LOOP_PASSES` (default 55).
Loop exits early when the queue is empty. Without this loop, a
cron-only worker would drain ~1 msg/minute regardless of
`OUTBOX_MAX_PER_SECOND` — turning a 10k backlog into days.

`aged_out` enforcement runs in the same loop: any `pending` occurrence with `scheduled_for < now() - staleness_threshold_hours` is processed by the missed-run policy (audit + skip / escalate) and does **not** consume rate-limit tokens.

### 7.3 Locking and concurrent workers (Requirement 5)

**Engine pick** uses Postgres advisory:

```sql
BEGIN;
SELECT * FROM occurrences
 WHERE status = 'pending' AND scheduled_for <= now()
 ORDER BY scheduled_for
 FOR UPDATE SKIP LOCKED
 LIMIT 20;
-- in the same tx, claim each:
UPDATE occurrences
   SET status = 'claimed', claimed_by = $worker_id, claimed_at = now()
 WHERE id = ANY($ids);
COMMIT;
```

`FOR UPDATE SKIP LOCKED` means two engine instances never see the same row. The claim is a lease — another worker may steal it if `claimed_at < now() - LEASE_TTL`, by repeating the same flow against `status='claimed' AND claimed_at < ...`.

**Series cancellation** runs in one transaction and bumps the version:

```sql
BEGIN;
UPDATE series
   SET status = 'cancelled', cancelled_at = now(), version = version + 1
 WHERE id = $series_id AND status = 'active';
UPDATE occurrences
   SET status = 'cancelled', completed_at = now()
 WHERE series_id = $series_id AND status IN ('pending', 'claimed');
COMMIT;
```

**Next-occurrence creation** by the engine uses the version:

```sql
INSERT INTO occurrences (...)
SELECT ...
  FROM series
 WHERE id = $series_id
   AND status = 'active'
   AND version = $observed_version;
-- 0 rows affected → series was cancelled / edited mid-tick; engine drops the
-- next-occurrence attempt and audits 'series_cancelled_during_advance'.
```

Combined: a cancellation racing with an in-flight `advance()` either pre-empts it (status check returns 0 rows on the insert) or the cancel itself drops the about-to-be-created row anyway. **No "ghost" occurrences post-cancellation.**

### 7.4 Correlation tokens (Requirement 6)

Each `recurring_outreach` occurrence stores a `correlation_token`: a 4-hex string like `A4F2`. The outbound message template appends `\n\n_ref: A4F2_` (formatted as italic via WhatsApp's markdown to look incidental, not technical).

When the engine's inbound hook sees a text from a known destinatario:

1. **Regex first** — search for `_ref:\s*([A-F0-9]{4})_` (case-insensitive). If a match exists and an active occurrence with that token belongs to the sender, route the response there. **Match.**
2. **Single-candidate fallback** — if no token but exactly one active occurrence with this destinatario, route there (preserves usability if the third party stripped the ref).
3. **Disambiguation** — multiple candidates and no token → engine creates a `pending_question` to the **owner** (not the destinatario): "Mariana respondeu mas tenho 2 pedidos abertos com ela. Foi sobre [A: relatório Empresa A] ou [B: relatório Empresa B]?". The owner's reply resolves which occurrence gets the response. The destinatario's text is **held**, not lost.

For `exclusive_per_destinatario=true` series, case 3 never happens because the engine refuses to start a second concurrent occurrence.

### 7.5 Audit trail per occurrence (Requirement 7)

Every state transition writes `audit_log` with `occurrence_id` populated. The canonical "tell me everything about this occurrence" query is one statement:

```sql
SELECT
  o.id, o.series_id, o.scheduled_for, o.status, o.outcome,
  o.contexto_snapshot,
  json_agg(
    json_build_object(
      'at', a.created_at,
      'acao', a.acao,
      'metadata', a.metadata,
      'pessoa_id', a.pessoa_id
    ) ORDER BY a.created_at
  ) FILTER (WHERE a.id IS NOT NULL) AS events
FROM occurrences o
LEFT JOIN audit_log a ON a.occurrence_id = o.id
WHERE o.id = $1
GROUP BY o.id;
```

For an entire series:

```sql
SELECT o.id, o.scheduled_for, o.status, o.outcome
  FROM occurrences o
 WHERE o.series_id = $1
 ORDER BY o.scheduled_for DESC;
```

## 8. Tools (LLM-facing surface)

### 8.1 `schedule_reminder` (rewritten)

Input unchanged from owner perspective. Implementation creates a series with `tipo='one_shot_reminder'`:

```ts
input  = { quando: ISO, texto: string<=500, entidade_id?: UUID, canal?: 'whatsapp' }
output = { series_id, occurrence_id, scheduled_for }
```

The first (and only) occurrence is created in the same transaction. Tool action key: `schedule_reminder`. Audit: `series_created` + `occurrence_scheduled`.

### 8.2 `cancel_reminder` / `cancel_series` (unified)

```ts
input  = { series_id: UUID, reason?: string }
output = { cancelled: boolean, occurrences_cancelled: number }
```

Atomic transaction per §7.3. Replaces the older `cancel_workflow`. The standalone `cancel_reminder` is preserved as a thin wrapper for LLM ergonomics (the model can stay on the verb it knows for one-shots).

### 8.3 `start_recurring_outreach`

```ts
input = {
  rrule: string,
  destinatario_pessoa_id: UUID,
  forward_to_pessoa_id?: UUID,
  message_template: string<=2000,         // supports {{nome}}, {{mes_anterior}}; ref token appended automatically
  forward_template?: string<=2000,        // supports {{resposta}}, {{nome}}
  wait_response_hours?: int (1..720, default 48),
  month_end_policy?: MonthEndPolicy,
  missed_run_policy?: MissedRunPolicy,    // default 'escalate_to_owner' for outreach
  exclusive_per_destinatario?: bool,      // default false
  entidade_id: UUID,
  dual_approval_granted: bool,            // C-007 requires true
}
```

### 8.4 `start_recurring_payment`

```ts
input = {
  rrule: string,
  conta_id: UUID,
  valor: number > 0,
  descricao: string<=280,
  categoria_id?: UUID,
  contraparte_id?: UUID,
  escalate_after_hours?: int (1..168, default 4),
  month_end_policy?: MonthEndPolicy,
  missed_run_policy?: MissedRunPolicy,    // default 'fire_latest_only' for payments
  entidade_id: UUID,
}
```

C-006 enforces `valor <= VALOR_LIMITE_DURO` at creation.

## 9. Constitutional rules (added/refined)

- **C-006**: `start_recurring_payment` with `valor > VALOR_LIMITE_DURO` is forbidden at creation. Applies to **scheduled** intent, not just dispatch.
- **C-007**: `start_recurring_outreach` requires `dual_approval_granted=true` at creation. One approval covers the recurring contract; each cycle inherits it via the series, but the *cycle itself* still passes through the engine which respects the series row state.
- **C-008 (new)**: An occurrence whose `contexto_snapshot.valor > VALOR_LIMITE_DURO` is rejected when claimed by the engine. Defence in depth: prevents a previously-valid series from firing if `VALOR_LIMITE_DURO` was lowered after creation.

## 10. Workers

| Worker | Cron | Purpose |
|---|---|---|
| `scheduling_tick` | `* * * * *` (1 min) | (a) Reclaim expired occurrence leases (rows return to `pending`); (b) claim due `pending` occurrences and advance state machine (each advance is one DB transaction — task update + occurrence update + outbox enqueue commit atomically); (c) claim `in_progress` occurrences whose advance was paused waiting for an external response (outreach `forward` step); (d) scan `awaiting_third_party` for `wait_response_hours` timeouts and escalate. |
| `outbox_drain` | `* * * * *` (1 min, runs the drain pass) | (a) Reclaim expired outbox leases (rows return to `pending`); (b) claim due `outbox_messages`; (c) for each, apply per-second / per-hour / per-recipient backpressure gates and send via Baileys (or alerts for `email_alert` kind); (d) mark sent / failed-retryable / dead. |
| `series_next_scheduler` | `*/10 * * * *` | For every active series whose chain has no pending future occurrence (failure or crash between completed-cycle and re-schedule), compute and insert the next one. Belt-and-suspenders for the rescheduling path inside `scheduling_tick`. |

The lease-reaper passes are folded into `scheduling_tick` / `outbox_drain` because they share locking semantics (`FOR UPDATE SKIP LOCKED`) and need to run in the same process to avoid losing reclaimed rows between cron firings. A reclaimed row goes back to `status='pending'` (its `claimed_by` / `claimed_at` cleared), so the subsequent `claimDue` in the same tick picks it up naturally.

## 11. Migration plan

Migration `007_scheduling.sql` (the v1 draft is dropped from this branch) becomes the operational schema:

1. Create `series`, `occurrences`, `tasks`, `outbox_messages`.
2. Add `occurrence_id` to `audit_log`.
3. Drop the unused `chain_id` column / index from the v1 attempt (only if applied; safe to skip if not).

No data migration needed — there are no v1 rows in production.

## 12. Rollout

1. Apply migration on staging.
2. Deploy code; `FEATURE_SCHEDULING_V2=true` enables the new tools and workers. Default off in case of unforeseen prod issues.
3. Run shadow mode for 24h: workers run, but `outbox_drain` sends only to a single owner-test JID. Confirm metrics (queue depth, send rate, error rate).
4. Enable for production owner. Monitor `payment_due` runs for one full cycle (one month).
5. Open to spouse + team after first full successful cycle.

## 13. Acceptance criteria — the seven tests

Each criterion is a single integration test in `tests/integration/scheduling/`:

| # | Test file | What it proves |
|---|---|---|
| 1 | `outbox-crash-no-loss.spec.ts` | Crash between task commit and outbox send: next tick still delivers. |
| 2 | `backpressure-10k-drain.spec.ts` | 10k due occurrences drain under configured limits, never exceeding `OUTBOX_MAX_PER_SECOND`. |
| 3 | `month-end-policy.spec.ts` | All four `month_end_policy` values produce documented dates for BYMONTHDAY=31 across feb/apr/jun/sep/nov. |
| 4 | `missed-run-policy.spec.ts` | Simulated 5-day downtime: each `missed_run_policy` value produces the documented audit + fire pattern. |
| 5 | `cancel-race.spec.ts` | Concurrent `cancel_series` + engine tick: no new occurrence is created post-cancellation, no occurrence is dispatched post-cancellation. |
| 6 | `multi-pending-disambiguation.spec.ts` | Two open outreach occurrences with same destinatario: response without token triggers disambiguation pending_question to the owner; response with matching token routes directly. |
| 7 | `audit-trail-per-occurrence.spec.ts` | Single SQL query returns the full ordered event chain for any occurrence from creation through final outcome. |

All seven must pass in CI before merge.

## 14. Observability

Metrics (Prometheus-shape, exposed via spec 17):

- `scheduling_engine_tick_duration_ms` (histogram)
- `scheduling_occurrences_claimed_total` (counter, by tipo)
- `scheduling_occurrences_status` (gauge, by status)
- `scheduling_outbox_queue_depth` (gauge)
- `scheduling_outbox_send_total` (counter, by kind, outcome)
- `scheduling_outbox_attempts` (histogram)
- `scheduling_aged_out_total` (counter, by tipo)
- `scheduling_cancel_race_drops_total` (counter — series_cancelled_during_advance)

Audit actions:

`series_created`, `series_cancelled`, `series_cancelled_during_advance`,
`occurrence_scheduled`, `occurrence_claimed`, `occurrence_aged_skipped`,
`occurrence_completed`, `occurrence_failed`, `occurrence_cancelled`,
`outbox_enqueued`, `outbox_sent`, `outbox_failed`, `outbox_dead`,
`reminder_fired`, `outreach_sent`, `outreach_response_captured`,
`outreach_response_disambiguation_required`, `outreach_response_dropped_no_match`,
`payment_due_proposed`, `payment_due_confirmed`, `payment_due_skipped`,
`payment_due_postponed`, `payment_due_unanswered`.

## 15. Operational concerns

- **Backup**: all new tables included in nightly Postgres dump (spec 17 §4); restore-test exercises one full series → occurrence → outbox round-trip.
- **DLQ**: any outbox row that reaches `dead` triggers an alert via spec 17 (email/Telegram). `npm run dlq` shows scheduling DLQ alongside agent queue.
- **Cleanup**: `occurrences` in terminal states (`completed`, `skipped`, `failed`, `aged_out`, `cancelled`) older than 365 days can be archived to cold storage. Not implemented Phase 1; flag in metrics if `occurrences` table exceeds 100k rows.
