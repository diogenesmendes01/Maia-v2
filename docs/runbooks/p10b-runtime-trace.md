# Runbook — P10b Runtime Trace

> How to operate, debug, and roll back the dual-pattern runtime trace: synchronous envelope written BEFORE every side effect with `side_effect_level >= medium` (CRITICAL invariant 12), plus asynchronous body persistence with HMAC-SHA256 tenant-scoped signing (CRITICAL invariant 8), redaction policy, and the `unified_trace_events` materialized view.

## What P10b ships

A two-table audit pipeline + durable outbox + 3 workers + 1 materialized view:

- `runtime_trace_envelopes` (migration 041): the narrow synchronous record proving a decision was made. PK = `trace_id`. Written in <20ms p99 (audit gate). Carries `decision`, `side_effect_level`, `policy_id`, `redaction_class`, `envelope_hmac`, `hmac_key_version`, `body_status`.
- `runtime_trace_bodies` + `runtime_trace_body_outbox` (migration 042): the heavy body — redacted `ExecutionContextPacket` + `DecisionPacket` (PK = `trace_id`, `ON CONFLICT DO NOTHING` for idempotent at-least-once delivery), plus a **durable outbox** table written transactionally with the envelope so a process crash never strands the packet (Codex review #102 issue 4).
- `unified_trace_events` matview (migration 043): UNION ALL across 7 source tables (audit_log, cognitive_module_log, agent_drift_alerts, role_selector_decisions, capability_test_results, procedure_execution_events, runtime_trace_envelopes), refreshed CONCURRENTLY every 5 minutes.

> Migration numbering coordinated with parallel PRs: P8e=036/037, P8b=036/036b/036c/037, P8c=038, P8d=040, P10b=041/042/043. The matview references `role_selector_decisions.decided_role_id` + `decided_at` — confirmed against migration 034 by `tests/unit/p10b-migrations-smoke.spec.ts`.

Workers (in `src/workers/`):

- `trace_body_writer` (cron `* * * * *`): drains the in-process queue of bodies enqueued by the request path. Calls `writeBody()` which redacts + persists + flips the envelope's `body_status` to `persisted`.
- `trace_body_recoverer` (cron `*/5 * * * *`): walks pending envelopes older than `RUNTIME_TRACE_BODY_ORPHAN_SEC` (default 300). LEFT JOINs `runtime_trace_bodies` to detect "body landed but envelope flip lost"; otherwise marks the envelope `orphaned` and alerts.
- `trace_matview_refresh` (cron `*/5 * * * *`): `REFRESH MATERIALIZED VIEW CONCURRENTLY unified_trace_events`.

## Architecture invariants (founder approval to change)

| # | Invariant | Where enforced |
|---|---|---|
| 8 | HMAC-SHA256 is tenant-scoped (no cross-tenant dictionary attack) | `src/control-plane/runtime-trace/lib/hmac.ts` — HKDF derives a per-tenant key from the master KMS material. **Fail-closed**: throws if `RUNTIME_TRACE_HMAC_MASTER_SECRET` is absent in prod (Codex #102 issue 2). |
| 12 | Envelope MUST be written BEFORE any side effect with `side_effect_level >= medium` | `src/control-plane/runtime-trace/envelope-writer.ts` throws on failure; caller MUST abort the side effect |
| — | Redaction policy is a **strict allowlist** — `STRUCTURAL_TOP_LEVEL` + `DECISION_TOP_LEVEL` + special-cased `request`/`soul`/`user_layer`; unknown top-level fields are DROPPED (Codex #102 issue 5) | `src/control-plane/runtime-trace/lib/redaction.ts` |
| — | Debug mode is AES-256-GCM + S3 with 24h TTL + MFA-gated read. **Durability**: real `PutObject` when bucket configured, or inline ciphertext in DB row when not — never silent-drop (Codex #102 issue 3). | `lib/debug-encrypt.ts` + `body-writer.ts` + DB CHECK constraint `runtime_trace_bodies_encrypted_has_storage` |
| — | Body packet is preserved via durable outbox row written in the same transaction as the envelope (Codex #102 issue 4) | `runtime_trace_body_outbox` table + `envelope-writer.ts` + `trace-body-writer.ts` worker drains via `FOR UPDATE SKIP LOCKED` |

## Feature flag

`FEATURE_RUNTIME_TRACE_V1` (default OFF). Activation:

```env
FEATURE_RUNTIME_TRACE_V1=true
RUNTIME_TRACE_HMAC_MASTER_SECRET=<KMS-fetched material>
RUNTIME_TRACE_HMAC_KEY_VERSION=1
# Optional — debug mode + recoverer tuning:
RUNTIME_TRACE_DEBUG_S3_BUCKET=maia-trace-debug-prod
RUNTIME_TRACE_DEBUG_AES_KEY=<base64 32 bytes>
RUNTIME_TRACE_BODY_ORPHAN_SEC=300
```

With the flag OFF, `trace()` returns a no-op envelope (empty `envelope_hmac`, `hmac_key_version=0`) and does NOT touch the DB. Side-effect callers that wrap themselves with `trace()` keep working — they just have no audit row to look up later.

## Calling convention

Tools/PEPs that perform side effects with `side_effect_level >= medium` MUST do:

```ts
import { trace } from '@/control-plane/runtime-trace/index.js';

const env = await trace({
  trace_id, tenant_id, agent_id, conversa_id, turno_id,
  packet: executionContextPacket,
  decision: decisionPacketFromP9b,
  redaction_class: 'standard', // | 'debug' | 'minimal'
});
// ↑ if this throws, DO NOT run the side effect.
// On success, the envelope is durably written and the body is enqueued
// for async persistence.

await actuallyDoTheThing();
```

`trace()` is the public surface. `writeEnvelope`/`writeBody` are exposed for the workers and for advanced callers that need the envelope-without-body pattern (rare).

## Key rotation (90 days)

1. Generate a new master secret in KMS.
2. Bump `RUNTIME_TRACE_HMAC_KEY_VERSION` (e.g. `1` → `2`) and update `RUNTIME_TRACE_HMAC_MASTER_SECRET` in the rolling deploy.
3. Restart workers — the HMAC cache (`KEY_CACHE` in `lib/hmac.ts`) is process-local; restart drops it.
4. Old envelopes/bodies keep their `hmac_key_version` column so verifies still work against the previous master.
5. After 180 days (= 2 rotation periods), the previous master can be retired from the verifier path.

No re-signing of historical rows. Each row carries its own version; the verifier loads the right key on demand.

## Recovery from "orphaned" body

When the recoverer marks envelopes as `body_status='orphaned'`, the body was never persisted within `RUNTIME_TRACE_BODY_ORPHAN_SEC`. Two likely causes:

1. The body writer worker crashed mid-tick (in-process queue lost). Recover the body from logs if available; otherwise the envelope alone is the audit trail (decision recorded, context lost).
2. The body writer is healthy but the DB INSERT failed N times. Check `maia_runtime_trace_body_writer_failed_total` counter and recent logs for the underlying cause.

For a one-off backfill of a known-lost body, use a manual `INSERT INTO runtime_trace_bodies ... ON CONFLICT DO NOTHING` from psql.

## Rollback

P10b is purely additive — flip `FEATURE_RUNTIME_TRACE_V1=false` to stop new writes. Old rows stay; queries against `unified_trace_events` still work. Workers continue running (they're idempotent no-ops on an empty queue / no orphans).

To fully remove:

1. Disable the workers in `src/workers/index.ts` (`phase > 6`).
2. Run `migrations/043_p10b_unified_trace_events_matview_down.sql`.
3. Run `migrations/042_p10b_runtime_trace_bodies_down.sql` (drops both `runtime_trace_bodies` and `runtime_trace_body_outbox`).
4. Run `migrations/041_p10b_runtime_trace_envelopes_down.sql`.

DO NOT drop the tables while the flag is still ON in another replica — concurrent writers will hit a hard error.

## Diagnostics

Counters (Prometheus):

- `maia_runtime_trace_envelope_written_total{decision,side_effect_level,redaction_class}` — envelope writes, per decision.
- `maia_runtime_trace_envelope_write_failed_total{decision,side_effect_level}` — should be flat-zero. Spike means callers are blocked on the audit gate.
- `maia_runtime_trace_envelope_latency_ms` — histogram. p99 < 20ms.
- `maia_runtime_trace_body_written_total{redaction,encrypted}` — body persistences.
- `maia_runtime_trace_body_latency_ms` — histogram.
- `maia_runtime_trace_body_writer_ok_total` / `_failed_total` — per worker tick.
- `maia_runtime_trace_body_recoverer_persisted_total` — body landed late but recovered.
- `maia_runtime_trace_body_recoverer_orphaned_total` — bodies declared lost. Page ops if > 0 sustained.

Health rows: `system_health_events` for `trace_matview_refresh` (component name). Investigate `down` rows immediately — matview staleness blocks the Admin UI trace browser.

Quick SQL probes:

```sql
-- Pending envelopes (should drain fast):
SELECT count(*) FROM runtime_trace_envelopes WHERE body_status = 'pending';

-- Orphaned envelopes (should be near-zero):
SELECT count(*) FROM runtime_trace_envelopes WHERE body_status = 'orphaned';

-- Recent decisions per tenant:
SELECT tenant_id, decision, count(*)
FROM runtime_trace_envelopes
WHERE created_at > now() - interval '1 hour'
GROUP BY tenant_id, decision;

-- Cross-table timeline for a conversa (uses matview):
SELECT source, event_kind, summary, occurred_at
FROM unified_trace_events
WHERE conversa_id = '<uuid>'
ORDER BY occurred_at DESC
LIMIT 50;
```

## Integration with not-yet-merged work

P10b ships standalone — types for P8a (`ExecutionContextPacket`) and P9b (`DecisionPacket`) are stubbed locally in `src/control-plane/runtime-trace/types.ts` (`ExecutionContextPacketStub`, `DecisionPacketStub`). When #96 (P8a) and the decision engine merge, replace the stub imports with the real types — the field set the trace cares about is a subset of both, so the cutover is a pure type swap with no behavioral change.
