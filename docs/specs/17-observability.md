# Spec 17 — Observability: Logging, Metrics, Healthchecks, Alerts, Resilience

**Status:** Foundation • **Phase:** 1 • **Depends on:** 00, 01, 02, 04, 06, 09, 12

---

## 1. Purpose

Define how Maia is **operated** in production: structured logs, metrics, healthchecks, alerts (email + Telegram), the dead-letter queue, and the resilience patterns (LLM fallback, circuit breakers, Redis-down policy, backups). This spec is the operator's manual.

## 2. Goals

- All logs structured JSON (Pino), with secrets redacted.
- Closed-set audit-action taxonomy.
- Healthcheck endpoints per component, with `ok | degraded | down` status.
- Two alert channels: email (SMTP) + Telegram bot.
- Dead-letter queue persisted in Postgres.
- LLM fallback chain Sonnet → Haiku → (Phase 2) Ollama.
- Backup nightly: 7 days local + 30 days cloud, monthly restore drill.

## 3. Non-goals

- APM tracing (Datadog/NewRelic). Personal scale; logs + metrics suffice.
- Live ops dashboard (Grafana). Out of scope; tail logs.
- HA/clustering. Single instance.

## 4. Logging

### 4.1 Format

Pino, JSON output. Minimum fields per record:

```json
{
  "level": "info",
  "time": "2026-04-28T12:34:56.789Z",
  "pid": 12345,
  "hostname": "maia-app",
  "request_id": "req-abc",
  "conversa_id": "uuid-or-null",
  "pessoa_id": "uuid-or-null",
  "module": "agent.core",
  "msg": "tool_dispatch",
  "tool": "register_transaction",
  "duration_ms": 123
}
```

### 4.2 Redaction

```typescript
const logger = pino({
  redact: {
    paths: [
      '*.ANTHROPIC_API_KEY', '*.OPENAI_API_KEY', '*.VOYAGE_API_KEY',
      '*.TELEGRAM_BOT_TOKEN', '*.SMTP_PASS', '*.POSTGRES_PASSWORD',
      'authorization', 'cookie',
      'config.ANTHROPIC_API_KEY', 'config.OPENAI_API_KEY', /* ... */
      'pessoa.telefone_whatsapp', // PII at INFO+; allowed only at DEBUG
    ],
    censor: '[REDACTED]',
  },
});
```

Phone numbers are redacted at INFO and above; visible at DEBUG for development.

### 4.3 Levels

| Level | When |
|---|---|
| `debug` | local dev only; verbose tool dispatch, prompt blocks, tokens |
| `info` | normal operations; conversation events, tool successes |
| `warn` | recoverable abnormalities; LLM retry, idempotency hit, audit anomaly |
| `error` | exceptions, tool failures, integration outages |

`LOG_LEVEL` env (spec 01) sets the cutoff. Default `info`.

## 5. Metrics

A small set of counters and gauges, exposed at `GET /metrics` (Prometheus text format) for optional scraping. Only used if owner runs Prometheus + Grafana — not required.

### 5.1 Counters

```
maia_messages_received_total{direcao, tipo}
maia_tool_calls_total{tool, status}
maia_llm_calls_total{provider, model, status}
maia_llm_tokens_total{provider, model, kind=input|output}
maia_dual_approvals_total{status=requested|granted|denied|timeout|executed}
maia_idempotency_hits_total{tool}
maia_dlq_jobs_total{queue}
maia_audit_events_total{action}
```

### 5.2 Gauges

```
maia_pending_questions_open
maia_workflows_in_flight
maia_redis_connected{0|1}
maia_db_connected{0|1}
maia_baileys_connected{0|1}
maia_circuit_state{provider}{0=closed,1=half_open,2=open}
```

### 5.3 Histograms

```
maia_request_duration_ms{kind=tool|llm|http}
maia_llm_latency_ms{provider, model}
```

## 6. Healthchecks

`Fastify` mounts the following routes:

| Path | Returns |
|---|---|
| `GET /health` | composite `{ status: 'ok'|'degraded'|'down', components: [...] }` |
| `GET /health/db` | `{ component:'db', ... }` |
| `GET /health/redis` | `{ component:'redis', ... }` |
| `GET /health/whatsapp` | `{ component:'whatsapp', ... }` |
| `GET /health/llm` | `{ component:'llm', ... }` |
| `GET /health/whisper` | `{ component:'whisper', ... }` |
| `GET /health/embedding` | `{ component:'embedding', ... }` |

Response shape:

```json
{
  "component": "db",
  "status": "ok",
  "latency_ms": 5,
  "last_success_at": "2026-04-28T12:34:56Z",
  "last_failure_at": "2026-04-28T03:12:00Z",
  "details": {}
}
```

Worker `health_monitor` (spec 12 §5.1) writes results to `system_health_events` and emits alerts when transitions cross thresholds.

### 6.1 Threshold rules

| State | Duration | Action |
|---|---|---|
| `down` | > 2 min | alert all configured channels |
| `degraded` | > 10 min | alert all configured channels |
| Recovery | first `ok` after alert | "all clear" message |

## 7. Alerts

### 7.1 Channels

`ALERT_CHANNELS` env (comma-separated): `email`, `telegram`. Both supported simultaneously.

### 7.2 Email (SMTP)

Generic SMTP via Nodemailer. Settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO`. Plain text body, machine-friendly subject prefix `[MAIA ALERT]`.

### 7.3 Telegram bot

Direct REST API call to `https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id` and `text`. No external SDK. Markdown disabled (avoid escape pitfalls); plain text.

### 7.4 Events that fire alerts

```
- whatsapp_disconnect (> WHATSAPP_RECONNECT_ALERT_MIN)
- db_down (> 1 min)
- redis_down (> 2 min)
- component_degraded (> 10 min)
- dlq_new_entry
- emergency_lockdown_activated
- import_run_pending_review_24h
- daily_llm_cost_above_threshold (configurable; default $5)
- backup_failed
```

Alert content: terse, one-line subject and structured body with timestamps and links to logs (file paths).

## 8. Audit-action taxonomy (closed list)

Single source of truth lives in `governance/audit-actions.ts`. Adding new actions requires a code change and corresponding test.

```typescript
export const AUDIT_ACTIONS = [
  // Onboarding
  'person_created', 'person_activated', 'permission_preview_generated',
  'permission_confirmed', 'permission_changed', 'permission_revoked',
  'first_contact_received', 'owner_confirmed_identity',
  // Operacional
  'transaction_created', 'transaction_corrected', 'transaction_cancelled',
  'classification_suggested', 'reminder_scheduled',
  'boleto_parsed', 'audio_transcribed',
  // Inteligência
  'rule_learned', 'rule_promoted', 'rule_demoted', 'rule_banned',
  'fact_saved', 'memory_recalled', 'reflection_completed',
  // Governança
  'dual_approval_requested', 'dual_approval_granted',
  'dual_approval_denied', 'dual_approval_timeout', 'dual_approval_executed',
  'audit_mode_activated', 'audit_mode_deactivated',
  'audit_mode_deactivated_auto',
  'emergency_lockdown_activated', 'emergency_lockdown_lifted',
  // Segurança
  'unauthorized_access_attempt', 'rate_limit_exceeded',
  'unknown_number_message_received', 'group_message_ignored',
  'duplicate_message_dropped', 'auto_blocked_anomalous_volume',
  'permission_suspended_inactivity',
  // Sistema
  'system_started', 'system_stopped', 'config_loaded',
  'backup_completed', 'backup_failed',
  'restore_test_passed', 'restore_test_failed',
  'whatsapp_connected', 'whatsapp_disconnected',
  'llm_circuit_opened', 'llm_circuit_closed',
  'dashboard_session_started', 'dashboard_session_ended',
  // Dados / DLQ
  'dlq_job_added', 'dlq_job_resolved',
] as const;

export type AuditAction = typeof AUDIT_ACTIONS[number];
```

Database CHECK constraint **not** enforced (allows phased addition); code helper enforces type-safe insertion.

## 9. Dead-letter queue (DLQ)

### 9.1 Schema

Defined in spec 02 §5.8. Jobs that exhaust BullMQ retries route to `dead_letter_jobs` via the `failed` event handler.

### 9.2 Processing

- A small admin command `npm run dlq:list` lists open entries.
- `npm run dlq:retry <id>` re-enqueues to the original queue with a fresh attempt count.
- `npm run dlq:resolve <id>` marks resolved without retry.
- Owner can ask Maia: *"o que tá no DLQ?"* (read action; restricted to owner) — returns counts and recent entries.

Each new DLQ entry triggers a low-priority alert (`dlq_new_entry`).

## 10. Resilience patterns

### 10.1 LLM fallback chain (Phase 1)

```
Sonnet primary
  ├─ retry x3 with exponential backoff (2s, 4s, 8s) on 429 / 5xx / timeout
  └─ on retry exhaustion → Haiku (same SDK, same tool format)
       └─ on failure → enqueue to retry queue + reply user "instabilidade técnica"
```

Circuit breaker per provider (spec 06 §9.3). When circuit is `open`, requests skip directly to next provider.

### 10.2 Phase 2 — Ollama

`FEATURE_OLLAMA_FALLBACK=true` enables a third tier. Ollama is invoked only in **restricted mode**: tool descriptions are simplified; the prompt forbids `create_*` actions; outputs are JSON-validated heavily.

### 10.3 Redis-down policy

When `redis_available === false`, the dispatcher applies:

```typescript
const REDIS_DOWN_POLICY = {
  allowed: [
    'read_balance', 'list_transactions', 'list_pendings',
    'simple_qa', 'audit_query', 'help', 'persist_message',
  ],
  blocked: [
    'register_transaction', 'correct_transaction', 'cancel_transaction',
    'transferencia_interna', 'dual_approval_*', 'workflow_*',
    'send_proactive', 'transcribe_audio', 'parse_boleto',
    'reflection_workflow',
  ],
};
```

Maia warns the user that financial actions are paused. Messages are still persisted.

### 10.4 DB-down policy

Hard stop. The system cannot operate without Postgres. The healthcheck reports `down`; alerts fire. The gateway refuses to ACK; WhatsApp will redeliver upon recovery.

### 10.5 Baileys-down policy

The agent loop continues to run (background workers, reflection batch). Outbound messages requiring WhatsApp queue up. When Baileys returns, the queue drains.

## 11. Backups

### 11.1 Schedule

Cron `0 3 * * *`:

```bash
pg_dump --no-owner -Fc $DATABASE_URL > $BACKUP_DIR/maia-$(date +%Y%m%d).dump
```

### 11.2 Retention

| Location | Retention |
|---|---|
| Local | `BACKUP_RETENTION_LOCAL_DAYS` (default 7) |
| Cloud (S3-compatible) | `BACKUP_RETENTION_CLOUD_DAYS` (default 30) |

Cleanup runs same cron after upload. `BACKUP_S3_BUCKET` env enables cloud upload; missing env → local only and alert at boot.

### 11.3 Restore drill

Cron `0 4 1 * *` (1st of month, 04:00):

```bash
DRILL_DB="${POSTGRES_DB}_restore_drill"
createdb $DRILL_DB
pg_restore --no-owner -d $DRILL_DB $LATEST_BACKUP
```

If restore succeeds and a sanity query runs (`SELECT count(*) FROM transacoes`), audit `restore_test_passed`. On failure, `restore_test_failed` + alert.

## 12. Cost monitoring

Every LLM and embedding call updates a daily counter in `agent_facts`:

```
agent_facts['cost.daily.llm.<YYYY-MM-DD>']      = { tokens_input, tokens_output, usd_cents }
agent_facts['cost.daily.embedding.<YYYY-MM-DD>'] = { tokens, usd_cents }
agent_facts['cost.daily.whisper.<YYYY-MM-DD>']   = { seconds, usd_cents }
```

Worker computes a daily total at 02:30 and alerts if above threshold (default $5/day; configurable).

## 13. LLM Boundaries

The LLM may:

- Read its own latency from prompt context (briefing-time).
- Be informed of degraded modes via system prompt block 7.

The LLM may not:

- Modify its own routing.
- Suppress alerts.
- Read raw audit logs en masse; only via the `audit_query` tool with scope filters.

## 14. Behavior & Rules

### 14.1 No silent failures

Every catch block writes structured log + audit (where applicable). The only "silent" path is the dedup gate, which writes audit but does not log at info level.

### 14.2 Correlation id

Every inbound message gets a `request_id` (UUID v7). Carried through all logs, audit rows, tool calls, LLM calls. Indispensable for debugging.

### 14.3 Time

All timestamps are stored UTC. Display uses `config.TZ`. Logs use ISO 8601 in UTC.

## 15. Acceptance criteria

- [ ] All LLM calls are logged with provider, model, latency, and token counts.
- [ ] All audit-relevant operations write to `audit_log` with closed-taxonomy `acao`.
- [ ] Health endpoints respond in < 50ms p95.
- [ ] Killing Postgres causes alerts within 2 min.
- [ ] DLQ entry triggers a Telegram alert within 10 seconds.
- [ ] Backup runs successfully each night; monthly restore drill passes on a clean test database.
- [ ] LLM fallback from Sonnet to Haiku activates within 30s of repeated 429s.

## 16. References

- Spec 01 — config (alert/backup envs)
- Spec 02 — `audit_log`, `system_health_events`, `dead_letter_jobs`
- Spec 04 — Baileys disconnect events
- Spec 06 — LLM fallback details
- Spec 09 — audit actions used by governance
- Spec 12 — workers that drive monitoring
