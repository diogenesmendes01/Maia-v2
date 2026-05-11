# Spec 18 — Scheduling: Reminders, Recurring Outreach, Payment Due

**Status:** Phase 1 (reminder firer) + Phase 2 (recurring workflows) • **Depends on:** 00, 02, 06, 07, 09, 11, 12, 17

---

## 1. Purpose

Define the **proactive scheduling layer** of Maia — the system that lets her *act on time without being asked*. Three use cases:

1. **One-shot reminders to the owner** — "me lembra amanhã às 9 de pagar a Vivo".
2. **Recurring outreach involving third parties** — "todo dia 5, peça o relatório à Mariana e encaminhe pra Maria da contabilidade".
3. **Recurring payment confirmations** — "todo dia 10, me pergunte se devo pagar o aluguel R$ 4.500 da empresa 3".

The defining principle: **never auto-execute high-stakes actions**. Money never moves without owner confirmation in the same conversation turn — the scheduler triggers a confirmation, not the transaction itself.

## 2. Goals

- **Durability:** every scheduled action lives in Postgres (WAL-backed), not Redis. Survives crash, redeploy, multi-day downtime.
- **Backfill:** when Maia comes back from downtime, picks up all overdue items and asks the owner if they should still fire.
- **Idempotency:** the same fire never produces two messages or two transactions.
- **Auditability:** every fire, miss, and reschedule appears in `audit_log` with structured metadata.
- **Recurrence:** supports daily/weekly/monthly patterns with anchor day (e.g., "every 5th") via a minimal subset of iCal RRULE.
- **Cancellation:** owner can stop any scheduled item via a tool/CLI/dashboard.
- **No double-fire under concurrency:** workers use `FOR UPDATE SKIP LOCKED` semantics.

## 3. Non-goals

- General-purpose cron-as-a-service (no arbitrary user-supplied cron expressions).
- Sub-minute precision (60s scan resolution is the contract).
- Time zones beyond `America/Sao_Paulo` (single-tenant assumption from spec 00).
- A UI for editing recurrence rules (Phase 5 dashboard work, out of scope here).

## 4. Architecture overview

Two complementary mechanisms, one per phase:

| Use case | Mechanism | Phase |
|---|---|---|
| One-shot owner reminder | `agent_facts.chave LIKE 'reminder.%'` + cron worker `reminder_firer` | 1 |
| Recurring outreach to third party | `workflows` row with `tipo='outreach_recorrente'` + extended `tickEngine` | 2 |
| Recurring payment confirmation | `workflows` row with `tipo='payment_due'` + extended `tickEngine` | 2 |

Both mechanisms write to the same `audit_log`, use the same identity/permission resolution, and reuse the existing `sendOutboundText` / `pending_questions` rails.

### 4.1 Why two mechanisms, not one

A one-shot text reminder to yourself is a *post-it* — schema-less, cheap to create, no state machine, no DAG, no recurrence. Forcing it into the `workflows` table over-engineers the 80% case ("me lembra de X").

A recurring multi-step task involving third parties is fundamentally different: it has steps with dependencies, can wait for an external reply indefinitely, can fail mid-way and need rollback, and lives across many months. That's what the `workflows` table was designed for (spec 11).

The split costs one extra worker but keeps both paths simple and matches the existing data model conventions.

## 5. Phase 1 — Reminder firer

### 5.1 Data model

Reminders continue to live in `agent_facts`:

```
escopo = 'pessoa:<owner_uuid>'
chave  = 'reminder.rem-<uuid>'
valor  = {
  id: string,
  pessoa_id: string,           -- creator AND recipient (Phase 1 is self-reminders only)
  entidade_id: string | null,
  quando: string (ISO 8601),   -- when to fire
  texto: string,                -- message body, max 500 chars
  canal: 'whatsapp',
  fired_at?: string (ISO),     -- set when fired; presence makes the fact inert
  cancel_reason?: string,       -- set when cancelled
}
fonte = 'configurado'
```

No new table. The `agent_facts` index on `(escopo, chave)` is sufficient for lookups by owner; firing scans use a JSONB predicate.

**Why no new table?** The data is trivially shaped and already has an index on `(escopo, chave)`. Adding a table for a 4-field JSON record means one more migration to maintain, one more repo, one more place to update on schema drift. Re-evaluate at Phase 5 if reminders grow attributes (snoozing, multi-recipient, tags).

### 5.2 Tool changes (`schedule_reminder`)

The existing tool keeps its schema. One adjustment: `quando` is parsed and validated as ISO 8601, rejected if in the past by more than 60 seconds (a small grace window covers clock skew between Maia and the owner's mental model).

Adds soft validation: if `quando > now() + 1 year`, returns warning in `valor.metadata.warn_far_future` for the LLM to surface ("você marcou pra daqui a 18 meses, era isso mesmo?").

### 5.3 Tool changes (`cancel_reminder` — new)

```ts
input  = { reminder_id: string }
output = { cancelled: boolean, reason?: 'not_found' | 'already_fired' | 'already_cancelled' }
```

Side-effect: write. Audit action: `reminder_cancelled`. Sets `valor.cancel_reason = 'owner_request'` and `valor.fired_at = now()` so the firer skips it.

Scope: only the creator (`pessoa_id` in `valor`) can cancel. Constitutional check: requires `schedule_reminder` action permission.

### 5.4 Worker `reminder_firer`

**Location:** `src/workers/reminder-firer.ts`. **Cron:** `* * * * *` (every minute). **Phase:** 1.

```typescript
async function runReminderFirer(): Promise<void> {
  if (!isBaileysConnected()) return;          // graceful skip — see §5.5

  const due = await db.execute(sql`
    SELECT id, escopo, valor
    FROM agent_facts
    WHERE chave LIKE 'reminder.%'
      AND (valor->>'fired_at') IS NULL
      AND (valor->>'quando')::timestamptz <= now()
    ORDER BY (valor->>'quando')::timestamptz ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  `);

  for (const row of due) {
    await fireOne(row).catch(err =>
      logger.warn({ err, fact_id: row.id }, 'reminder_firer.row_failed')
    );
  }
}
```

`fireOne` flow:

1. Resolve `pessoa` by `escopo` (`pessoa:<uuid>` → `pessoas.id`). If missing or `status != 'ativa'`, mark `fired_at = now()` with `metadata.skip_reason = 'pessoa_invalid'` and audit `reminder_skipped`.
2. Build JID via the same logic as outbound dispatch (prefer the most recent `mensagens.metadata.remote_jid` of that pessoa to handle `@lid`).
3. Format text: `🔔 Lembrete: {texto}\n_agendado em {quando_relativo}_`.
4. `UPDATE agent_facts SET valor = jsonb_set(valor, '{fired_at}', to_jsonb(now()::text))` **before** the send (idempotency: if send fails, the row is already marked — operator inspects via audit).
5. Call `sendOutboundText(jid, text)`. Persist as `mensagens` row with `direcao='out'`, `metadata.reminder_id = id`.
6. Audit `reminder_fired` with `metadata = { reminder_id, delay_seconds, late_minutes }`.
7. On send failure: audit `reminder_send_failed` and re-insert into a DLQ entry so the operator sees it.

### 5.5 Graceful skip when Baileys disconnected

If `isBaileysConnected() === false`, skip the whole tick. The reminder stays `fired_at IS NULL` and gets picked up on the next tick where Baileys is up. The 60s scan interval bounds the worst-case delay to 60 seconds after reconnection.

### 5.6 Backfill behavior

If Maia was down for 3 hours and 12 reminders accumulated past their `quando`, the next tick fires all of them in ISO-time order, one minute apart? **No** — they fire in the same tick, in chronological order, with no artificial spacing. The 50-row LIMIT per tick prevents a backlog of 500 reminders from saturating the WhatsApp send queue; subsequent ticks drain the remainder.

Each fired reminder records `late_minutes = floor((now - quando)/60)` in metadata so the operator can see how stale the firing was. The text itself is **not** modified — the user gets the original message; staleness is an internal observability concern, not a UX one.

### 5.7 Audit actions added

- `reminder_fired` — successful WhatsApp send. Metadata: `{ reminder_id, late_minutes }`.
- `reminder_send_failed` — Baileys send threw. Metadata: `{ reminder_id, error }`.
- `reminder_skipped` — pessoa inactive / blocked / quarantined. Metadata: `{ reminder_id, skip_reason }`.
- `reminder_cancelled` — owner cancelled via `cancel_reminder` tool.

### 5.8 Tests

- Unit: `reminder-firer.spec.ts` — fires due, skips not-due, sets `fired_at`, handles Baileys disconnect, handles inactive pessoa, audits each branch.
- Unit: `cancel-reminder.spec.ts` — happy path, idempotent re-cancel, not-found, already-fired blocks.
- Integration: `reminder-flow.spec.ts` — full tool → DB → worker → WhatsApp mock cycle.

---

## 6. Phase 2 — Recurring workflows (`outreach_recorrente`, `payment_due`)

Both new workflow types share infrastructure: a minimal RRULE-like recurrence spec, an extended `tickEngine` that knows how to advance them, and the existing `pending_questions` rails for human confirmation.

### 6.1 Recurrence specification

A workflow's `contexto.rrule` is a string in the shape:

```
FREQ=<DAILY|WEEKLY|MONTHLY>;BYDAY=<MON|TUE|...>;BYMONTHDAY=<1-31>;BYHOUR=<0-23>;BYMINUTE=<0-59>
```

Only the listed components are supported (subset of iCal RFC 5545). Parsing/validation lives in `src/workflows/rrule.ts`. Examples:

- `FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9` — every 5th of the month at 9am
- `FREQ=DAILY;BYHOUR=8` — every day at 8am
- `FREQ=WEEKLY;BYDAY=MON;BYHOUR=10` — every Monday at 10am

`computeNext(rrule, after_ts)` returns the next ISO timestamp on or after `after_ts` matching the rule, in `America/Sao_Paulo`. If no match within 366 days, throws — guards against malformed input.

### 6.2 Workflow type: `outreach_recorrente`

**Purpose:** ask a third party for something on a schedule, optionally forwarding their response elsewhere.

**Contexto shape:**
```ts
{
  rrule: string,
  destinatario_pessoa_id: string,   // who Maia asks
  forward_to_pessoa_id?: string,    // optional: where to forward the reply
  message_template: string,          // sent to destinatario; supports {{mes_anterior}} {{nome}}
  forward_template?: string,         // sent to forward_to; supports {{resposta}}
  wait_response_hours: number,       // default 48; after this, escalate to owner
  owner_pessoa_id: string,           // for escalations
}
```

**Steps generated at workflow creation:**

```
1. send_outreach              — sends the prompt to destinatario
2. await_response             — sets workflow.status='aguardando_terceiro', listens for inbound
3. forward_or_close           — if forward_to set and response captured, send; else close
4. reschedule                 — compute next proxima_acao_em via rrule, reset steps for the next cycle
```

**Engine flow** (`tickEngine` extended):

```
when wf.tipo === 'outreach_recorrente' AND wf.status === 'pendente':
  if wf.proxima_acao_em <= now():
    execute step 1 (send_outreach):
      sendOutboundText(destinatario_jid, render(message_template, {mes_anterior: ...}))
      step.status = concluido, step.resultado.whatsapp_id = ...
      wf.status = 'aguardando_terceiro'
      step 2 (await_response).status = em_andamento
      step 2.iniciado_em = now()
      audit('outreach_sent', { wf, destinatario, message })

when wf.tipo === 'outreach_recorrente' AND wf.status === 'aguardando_terceiro':
  if (now() - step2.iniciado_em) > wait_response_hours:
    audit('outreach_no_response', ...)
    notify owner: "Mariana não respondeu o pedido de relatório de %s desde %s"
    wf.status = 'aguardando_humano'
    (owner replies 'pular' or 'esperar mais' via pending_question — handled in §6.4)

when an inbound mensagem arrives from destinatario_pessoa_id while wf.status === 'aguardando_terceiro':
  the agent loop detects it via a hook (see §6.5), captures the response,
  marks step 2 concluido, advances to step 3.

when wf.tipo === 'outreach_recorrente' AND wf.status === 'em_andamento' AND step 3 pending:
  if forward_to set:
    send forward_template (with {{resposta}} substituted) to forward_to_jid
  step 3.status = concluido
  step 4 (reschedule):
    next_at = computeNext(rrule, now())
    new workflow row created with same contexto and proxima_acao_em = next_at
    wf.status = 'concluido'
    audit('outreach_completed_and_rescheduled', { next: next_at })
```

**Why a NEW workflow row per cycle, not resetting steps in-place?** Auditability. Each cycle becomes a distinct row with its own start/end timestamps. Querying "did Maia run the dia-5 routine in March?" becomes a single SELECT.

### 6.3 Workflow type: `payment_due`

**Purpose:** prompt the owner to confirm a payment that should happen today. Maia **never** registers the transaction without explicit owner answer in the same turn.

**Contexto shape:**
```ts
{
  rrule: string,
  entidade_id: string,
  conta_id: string,
  natureza: 'despesa',                          // payments are always 'despesa'
  valor: number,
  descricao: string,                             // human-readable: "Aluguel Empresa 3"
  categoria_id?: string,
  contraparte_id?: string,
  escalate_after_hours: number,                  // default 4 — see §6.6
}
```

**Steps generated at creation:**

```
1. propose_payment            — creates a pending_question with payment details and options
2. await_owner_decision       — workflow waits in 'aguardando_humano' until question resolves
3. execute_or_skip            — if 'sim' → register_transaction; if 'não' → audit + skip; if 'adiar' → reschedule
4. reschedule                 — compute next, create next-cycle workflow row
```

**Engine flow:**

```
when wf.tipo === 'payment_due' AND wf.status === 'pendente':
  if wf.proxima_acao_em <= now():
    p = pendingQuestionsRepo.create({
      conversa_id: owner's active conversa,
      pessoa_id: owner.id,
      tipo: 'payment_confirmation',
      pergunta: 'Pagamento {descricao} de {valor} hoje? (sim / não / adiar)',
      opcoes_validas: [
        { key: 'sim', label: 'Pagar agora' },
        { key: 'nao', label: 'Pular este mês' },
        { key: 'adiar', label: 'Adiar 2 dias' },
      ],
      acao_proposta: { tool: 'register_transaction', args: {...} },
      expira_em: now() + escalate_after_hours hours,
      metadata: { workflow_id: wf.id }
    })
    send to owner via sendOutboundPoll OR text fallback (see spec 09)
    wf.status = 'aguardando_humano'
    step 1.status = concluido
    audit('payment_due_proposed', { wf, valor })

when pending_question resolves (handled by existing pending-resolver):
  it looks for metadata.workflow_id; if present, advance(wf, decision)

advance(wf, 'sim'):
  dispatch register_transaction via the normal tool path (constitutional checks fire normally — limit, dual_approval, etc.)
  step 3.status = concluido
  step 3.resultado = { transacao_id: ... }
  audit('payment_due_confirmed', { wf, transacao_id })
  step 4 reschedule

advance(wf, 'nao'):
  audit('payment_due_skipped', { wf })
  step 4 reschedule

advance(wf, 'adiar'):
  wf.proxima_acao_em = now() + 2 days
  wf.status = 'pendente'
  step 1-3 reset
  audit('payment_due_postponed', { wf, new_proxima_acao_em })

when pending_question expires unanswered:
  audit('payment_due_unanswered', { wf })
  trigger alert via sendAlert (email/telegram) — high-stakes silence is operator-visible
  wf.status = 'falhou'
  do NOT reschedule automatically — operator decides whether to resume
```

**Why expire-without-action is `falhou` not auto-skip?** A missed payment confirmation is a different signal from a "no" — it might mean the owner was unreachable, sick, or the system was offline. Defaulting to "skipped" risks rent going unpaid; defaulting to "alert + halt" risks duplicate work. We choose alert + halt because the failure mode is recoverable (operator restarts the workflow) but the silent-skip failure mode is not (rent past due).

### 6.4 Workflow type pause/resume tool: `cancel_workflow`

```ts
input  = { workflow_id: string, reason?: string }
output = { cancelled: boolean }
```

Constitutional gate: only `pessoa_envolvida` (creator) or owner can cancel. Sets `workflows.status = 'cancelada'`, any in-flight step → `'cancelada'`, audit `workflow_cancelled`. **Does not auto-cancel future cycles** — recurring workflows create their next-cycle row at `step 4 reschedule`, so cancelling the current row stops further iterations only if cancelled BEFORE step 4 runs. To stop ALL future cycles, the tool also looks up rows of the same logical chain via `contexto.chain_id` and cancels each.

`contexto.chain_id` (new field) is a UUID generated at first workflow creation and copied to each rescheduled cycle. Lets the operator stop the whole series with one call.

### 6.5 Capturing third-party responses (the `aguardando_terceiro` hook)

When an inbound text arrives, `agent/core.ts` already runs identity resolution. We add a pre-LLM hook: if the sender has any workflow in `aguardando_terceiro` status with `contexto.destinatario_pessoa_id === sender.id`, capture the inbound `conteudo` into `workflow_steps.resultado.response_text` of the `await_response` step, mark step `concluido`, set workflow back to `'em_andamento'`, and let the engine pick it up on the next tick (≤30s). The original inbound still flows to the LLM so Mariana can also have a conversational thread.

**Edge:** if the inbound is media (image, audio, document) and the workflow expected text — we save the inbound `mensagem_id` and `midia_url` into the step resultado, and forward as media if `forward_template` is empty, or skip forwarding with audit `outreach_response_was_media` if templated text is required. Phase 2.5 may relax this.

### 6.6 Time-zone handling

All `proxima_acao_em` computations use `America/Sao_Paulo` via `date-fns-tz` (already a dep). RRULE BYHOUR=9 means 9am in São Paulo, regardless of UTC offset (handles DST automatically).

### 6.7 Tool changes (`start_workflow` extended)

The `tipo` enum gains `'outreach_recorrente'` and `'payment_due'`. The Zod input schema branches per type to validate the matching `contexto` shape — no free-form JSONB blob accepted.

The tool's `audit_action` already exists (`reminder_scheduled`); we keep it but consider future split to `workflow_started` for clarity.

### 6.8 Constitutional rules added

**C-006 (new):** `payment_due` workflows with `valor > VALOR_LIMITE_DURO` are rejected at creation. The hard limit must hold at scheduling, not only at execution, to prevent attempts that would always fail.

**C-007 (new):** `outreach_recorrente` workflows require `dual_approval_granted = true` at creation (same rule as one-shot `send_proactive_message`, but applied to the *recurring contract*). Once approved, each cycle inherits the approval — the owner approves the *schedule*, not each fire.

### 6.9 Audit actions added

- `outreach_sent` — message sent to destinatario.
- `outreach_response_captured` — inbound matched a workflow.
- `outreach_no_response` — wait window expired.
- `outreach_completed_and_rescheduled` — cycle done, next row created.
- `outreach_response_was_media` — media path edge.
- `payment_due_proposed` — pending_question created.
- `payment_due_confirmed` — owner said yes, transaction created.
- `payment_due_skipped` — owner said no.
- `payment_due_postponed` — owner said adiar.
- `payment_due_unanswered` — pending_question expired, workflow halted.
- `workflow_cancelled` — series stopped.

### 6.10 Tests

- Unit: `rrule.spec.ts` — `computeNext` for DAILY/WEEKLY/MONTHLY across DST boundaries, leap years, BYMONTHDAY=31 in February (skip to next valid month).
- Unit: `engine-outreach.spec.ts` — happy path, no-response escalation, media response, cancellation mid-cycle.
- Unit: `engine-payment.spec.ts` — sim/nao/adiar branches, expire, hard-limit rejection at creation.
- Integration: `recurring-payment-flow.spec.ts` — start workflow → cron fires → owner answers → transaction created → next cycle scheduled.

## 7. Migration plan

Both phases share migration `007_scheduling.sql`:

```sql
-- Phase 2: chain_id on workflows for cancellation across cycles
ALTER TABLE workflows ADD COLUMN chain_id UUID;
CREATE INDEX idx_workflows_chain ON workflows (chain_id) WHERE chain_id IS NOT NULL;

-- Phase 2: index for engine scan
CREATE INDEX idx_workflows_due ON workflows (proxima_acao_em)
  WHERE status IN ('pendente', 'em_andamento', 'aguardando_terceiro');

-- Phase 1: index for reminder firer scan
-- agent_facts already has (escopo, chave) unique; add GIN on valor for the firer's predicate
CREATE INDEX idx_agent_facts_reminder_due ON agent_facts
  USING gin ((valor) jsonb_path_ops)
  WHERE chave LIKE 'reminder.%';
```

Down migration drops all new indexes and the column. No data loss.

## 8. Rollout

1. Phase 1 ships behind no feature flag (low risk: pure additive worker + tool, can't fire if no reminders are scheduled).
2. Phase 2 ships behind `FEATURE_RECURRING_WORKFLOWS=false` default. Each new workflow type added to `tickEngine` checks the flag and no-ops when off. Enables gradual production validation.
3. Run for one month with internal use (owner only) before opening to spouse/team.

## 9. Operational concerns

- **DLQ:** A reminder or workflow fire that exhausts retries lands in `dead_letter_jobs` with `queue_name='scheduling'`. Inspect via `npm run dlq`.
- **Alerts:** `payment_due_unanswered` always alerts via spec 17 channels (email/Telegram). `outreach_no_response` alerts only on the second consecutive miss.
- **Backups:** `agent_facts` and `workflows` are already in nightly Postgres dump (spec 17 §4).
- **Observability:** add `reminder_lateness_seconds` and `workflow_advance_duration_ms` to the metrics surface (spec 17).

## 10. Acceptance criteria (per phase)

**Phase 1 ready when:**
- Reminder created via tool fires at `quando ± 60s` in clean test.
- After Maia downtime > 1 hour, accumulated reminders fire on next tick in chronological order.
- Cancelled reminder never fires, even if `quando` already passed.
- All audit actions land with correct metadata shape.
- `npm test` green; integration test passes against real Postgres.

**Phase 2 ready when:**
- `outreach_recorrente` workflow created → first fire happens at the RRULE-computed time, Mariana receives the templated message, her text reply is captured into the step, forwarded to Maria, and next cycle is scheduled.
- `payment_due` workflow created → first fire posts a confirmation pending_question with three options, sim → transaction created in DB (with audit), não → no transaction, adiar → workflow re-fires in 2 days, unanswered → alert sent and workflow halted.
- `cancel_workflow` stops both current and all future cycles when given a `chain_id`.
- Constitutional checks reject `valor > LIMITE_DURO` at creation and require dual approval for outreach.
- All audit actions land with correct metadata shape.
