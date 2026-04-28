# Spec 12 — Proactive Workers: Cron, Event-Driven, Pattern-Driven

**Status:** Phase 4 (full) • Phase 1 (limited) • **Depends on:** 00, 02, 06, 09, 11, 17

---

## 1. Purpose

Define the workers that allow Maia to **act without being asked** — daily briefings, due-date alerts, anomaly detection, conversation summarization, rule-batch reflection, and outbound follow-ups. This is the layer that turns a chatbot into an assistant.

## 2. Goals

- Three categories of workers: **cron** (time-based), **event-driven** (DB triggers / queue events), **pattern-driven** (behavioral observation).
- Every proactive outbound message is **gated by governance** (spec 09): never sent without prior owner approval in Phase 1–2.
- Idempotent runs — a worker that runs twice for the same period produces the same effect.
- Single executor per worker (no double-fire) using BullMQ scheduling.

## 3. Non-goals

- Real-time streaming dashboards.
- Push notifications outside WhatsApp/email/Telegram alerting infra.

## 4. Architecture

### 4.1 Worker registry

```typescript
type Worker =
  | { kind: 'cron'; name: string; cron_expr: string; handler: () => Promise<void>; phase: number }
  | { kind: 'event'; name: string; trigger: EventTrigger; handler: (e: Event) => Promise<void>; phase: number }
  | { kind: 'pattern'; name: string; window: 'daily'|'weekly'; handler: () => Promise<void>; phase: number };

const WORKERS: ReadonlyArray<Worker> = [
  // Phase 1
  { kind: 'cron',   name: 'health_monitor',         cron_expr: '*/1 * * * *',  handler: runHealthMonitor,        phase: 1 },
  { kind: 'cron',   name: 'pending_expirer',        cron_expr: '*/1 * * * *',  handler: expirePendings,          phase: 1 },
  { kind: 'cron',   name: 'idempotency_cleanup',    cron_expr: '0 4 * * *',    handler: cleanupIdempotency,      phase: 1 },
  { kind: 'cron',   name: 'audit_mode_expirer',     cron_expr: '*/15 * * * *', handler: expireAuditMode,         phase: 1 },
  { kind: 'cron',   name: 'inactivity_sweep',       cron_expr: '0 3 * * *',    handler: inactivitySweep,         phase: 1 },
  { kind: 'event',  name: 'whatsapp_disconnect',    trigger: 'baileys.disconnect', handler: alertOnDisconnect, phase: 1 },
  { kind: 'event',  name: 'workflow_completion',    trigger: 'workflows.completed', handler: workflowReflection, phase: 1 },
  { kind: 'event',  name: 'user_correction',        trigger: 'agent.correction', handler: correctionReflection, phase: 1 },

  // Phase 2
  { kind: 'cron',   name: 'conversation_summarizer', cron_expr: '0 2 * * *',   handler: summarizeIdleConversations, phase: 2 },
  { kind: 'cron',   name: 'reflection_batch',        cron_expr: '0 2 * * *',   handler: nightlyReflection,       phase: 2 },

  // Phase 4
  { kind: 'cron',   name: 'briefing_morning',        cron_expr: '0 8 * * *',   handler: morningBriefing,         phase: 4 },
  { kind: 'cron',   name: 'briefing_evening',        cron_expr: '0 21 * * *',  handler: eveningBriefing,         phase: 4 },
  { kind: 'cron',   name: 'briefing_weekly',         cron_expr: '0 8 * * 1',   handler: weeklyBriefing,          phase: 4 },
  { kind: 'event',  name: 'due_date_watch',          trigger: 'recurrencias.due_soon', handler: dueDateAlert,    phase: 4 },
  { kind: 'event',  name: 'anomaly_detected',        trigger: 'anomaly.flagged', handler: anomalyAlert,          phase: 4 },
  { kind: 'pattern', name: 'pattern_briefing',       window: 'weekly',         handler: patternBriefing,         phase: 5 },
];
```

### 4.2 Scheduling

Cron workers register with `node-cron` at boot. BullMQ-repeatable jobs are used for any worker that should not double-fire across multiple processes (Phase 1 has a single process; this matters at Phase 5+).

### 4.3 Execution context

Every worker runs in a "system actor" context, distinct from any human:

```typescript
const SYSTEM_PESSOA = { id: '00000000-0000-0000-0000-000000000000', tipo: 'system' };
```

Audit log entries created by workers carry `pessoa_id = SYSTEM_PESSOA.id` (or `NULL` for backwards compatibility). Workers cannot impersonate a human pessoa.

## 5. Phase 1 workers (must ship with MVP)

### 5.1 `health_monitor`

Every minute:

1. Probe DB (`SELECT 1`) and Redis (`PING`) and Baileys socket and last-LLM-success-time.
2. Update `system_health_events` with current statuses.
3. Detect transitions (`ok → degraded`, `degraded → down`); when above threshold, send alerts via spec 17.

### 5.2 `pending_expirer`

Every minute:

```sql
UPDATE pending_questions SET status='expirada' WHERE status='aberta' AND expira_em < now();

UPDATE conversas SET metadata = jsonb_set(metadata, '{pending_question}', 'null'::jsonb)
WHERE metadata->'pending_question'->>'expira_em' < now()::TEXT;
```

Then for each newly expired `pending_action` (medium stratum): emit cancel message to user.

### 5.3 `idempotency_cleanup`

Daily at 04:00:

```sql
DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days';
DELETE FROM dead_letter_jobs WHERE resolved = TRUE AND resolved_at < now() - interval '60 days';
```

### 5.4 `audit_mode_expirer`

Every 15 minutes:

```sql
UPDATE pessoas SET preferencias = preferencias - 'modo_auditoria_ate'
WHERE (preferencias->>'modo_auditoria_ate')::TIMESTAMPTZ < now();
```

Audit `audit_mode_deactivated_auto` for each affected row.

### 5.5 `inactivity_sweep`

Daily at 03:00:

```sql
UPDATE permissoes p SET status='suspensa', updated_at=now()
WHERE status='ativa'
  AND p.pessoa_id IN (
    SELECT id FROM pessoas WHERE tipo NOT IN ('dono','co_dono')
  )
  AND NOT EXISTS (
    SELECT 1 FROM mensagens m
    JOIN conversas c ON m.conversa_id = c.id
    WHERE c.pessoa_id = p.pessoa_id AND m.created_at > now() - interval '60 days'
  );
```

For each suspended permission: notify owner; audit `permission_suspended_inactivity`.

### 5.6 `workflow_completion` (event)

Triggered when a `workflows.status` transitions to `'concluido'`. Per spec 06 §7.2: gather steps, run reflection, write rules and `agent_memories`.

### 5.7 `user_correction` (event)

Triggered by the agent loop when a correction is detected. Per spec 06 §7.1.

### 5.8 `whatsapp_disconnect`

When Baileys signals disconnect for > `WHATSAPP_RECONNECT_ALERT_MIN` minutes:

- Write `system_health_events` for component `whatsapp` with `status='down'`.
- Send alert via configured `ALERT_CHANNELS`.
- On reconnect: send all-clear and post a status reply to owner.

## 6. Phase 2 workers

### 6.1 `conversation_summarizer`

Daily at 02:00:

For every `conversas` with `status='ativa'` and `ultima_atividade_em < now() - interval '7 days'`:

1. Read all messages.
2. Ask LLM (Haiku, cheaper) for a summary in Portuguese, max 500 chars.
3. Write summary to `conversas.contexto_resumido`.
4. Set `conversas.status='encerrada'`.

The summary becomes context if the same pessoa starts a new conversation later.

### 6.2 `reflection_batch`

Daily at 02:00 (after summarizer):

Per spec 06 §7.3:

1. Aggregate yesterday's mensagens, transacoes, audit_log.
2. Group by signal type (corrections without rules, repeated patterns, anomalies).
3. For each group, ask LLM (Haiku) to propose `ReflectionRule`s.
4. Insert as probationary; bound to 200 LLM calls per night.

## 7. Phase 4 workers

### 7.1 `briefing_morning`

Cron `0 8 * * *` in TZ. For each `dono`/`co_dono`:

```
1. Compose briefing per spec 09 limits (`send_proactive_message` requires 4-eyes — but
   for owners, a "self-message" exemption applies because it does not leak data).
2. Format:
   - Saldos por entidade (Top 3)
   - Vencimentos próximos (próximos 3 dias)
   - Pendings: pending_questions abertas
   - Workflows abertos
   - Alertas: anomalias detectadas
3. Send via WhatsApp.
```

This worker uses the `send_proactive_message` tool with **owner exemption** baked in. External recipients (contadores, funcionários) require 4-eyes per usual.

### 7.2 `briefing_evening` (closing)

Cron `0 21 * * *`:

- Daily total movement per entity
- Suggested classifications pending review
- "Esquecimentos": transactions registered but not categorized

### 7.3 `briefing_weekly`

Monday 08:00:

- Receita / Despesa / Lucro per entity, last 7 days
- Comparison to previous week
- Trends

### 7.4 `due_date_watch` (event)

Triggered when `recorrencias.proxima_em` is within 3 days OR a `transacoes` row with `status='agendada'` and `data_competencia` within 1 day.

Action: notify owner; if `co_dono` permitted, also notify them; never notify externally without 4-eyes.

### 7.5 `anomaly_detected` (event)

Patterns from spec 09 §11. Action: alert owner with structured detail.

## 8. Phase 5 — pattern-driven

### 8.1 `pattern_briefing`

Weekly:

- Detects "every Monday morning Mendes asks for E3 balance" → preloads briefing element on Monday morning.
- Detects "Joana always sends balancete on day 7" → if she misses by day 8, ping owner.
- Stored as `agent_facts['pattern.<key>']` with confidence.

These are **suggestions**, not autonomous actions. The owner approves promoting a pattern to a rule.

## 9. LLM Boundaries

The LLM may:

- Compose briefing prose (after the backend prepares the data).
- Propose pattern observations from data.
- Generate reflection rules from logs.

The LLM may not:

- Decide *whom* to message.
- Override scheduling.
- Send a message bypassing `send_proactive_message` and its governance gates.

## 10. Behavior & Rules

### 10.1 Owner self-message exemption

Workers may send messages to `dono` or `co_dono` without dual approval, because these are the system's owners. This is encoded in `send_proactive_message`'s pre-execution: if `pessoa_destino.tipo IN ('dono','co_dono')`, the dual-approval gate is bypassed.

### 10.2 Quiet hours

Workers respect `agent_facts['preferencia.horario.limite_silencio'].horario` per pessoa (default 22:00–07:00 local). Briefings scheduled at 21:00 are sent at 21:00 only if the recipient's silence start is later, otherwise deferred to morning.

### 10.3 De-duplication of alerts

If `due_date_watch` fired yesterday for the same `transacao_id`, today's run does not refire unless the date changed.

### 10.4 Single-instance lock

Each worker acquires a `pg_try_advisory_lock(hashtext(name))` before running. If another instance holds it, this run is skipped (logged at debug level).

## 11. Error cases

| Failure | Behavior |
|---|---|
| Cron misses a tick (system was down) | Next tick processes; for daily workers, "missed" runs are not back-filled by default — exception: `health_monitor` |
| LLM fails during reflection batch | Job logged as failure; partial results saved; retry next night |
| Briefing send fails | Retry (via outbound DLQ); alert if unrecoverable |
| Pattern detection produces conflicting rules | Higher-confidence rule wins; both written to `learned_rules` for transparency |

## 12. Acceptance criteria

- [ ] Killing the app for 1 hour does not result in duplicate worker runs upon restart.
- [ ] `health_monitor` populates `system_health_events` every minute with low overhead (< 5ms per probe).
- [ ] `inactivity_sweep` correctly suspends a permission after 60 days of silence and sends owner notice.
- [ ] Phase 4 morning briefing runs at 08:00 in `TZ` regardless of UTC daylight changes.
- [ ] No external proactive message is ever sent without an explicit prior `send_proactive_message` 4-eyes approval (verified by audit log invariant).

## 13. References

- Spec 02 — `workflows`, `system_health_events`, `dead_letter_jobs`
- Spec 06 — reflection triggers
- Spec 09 — governance gates for outbound
- Spec 11 — workflow engine
- Spec 17 — alerting infrastructure
