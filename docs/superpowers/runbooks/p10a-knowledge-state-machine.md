# P10a — Knowledge State Machine — Operational Runbook

**Status:** GA after canary completion of `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`.
**Scope:** day-to-day operation of the 9-state lifecycle, the
auto-promoter worker, the `propose_*` tools, and the Admin UI Proposal
Inbox integration.

---

## 1. Quick reference

### 1.1 The 9 states

| # | Estado            | Visível ao LLM? | Weight | Label                       |
|---|-------------------|-----------------|--------|-----------------------------|
| 1 | `proposed`        | No (transit only) | 0.0  | —                           |
| 2 | `pending_review`  | No              | 0.0    | —                           |
| 3 | `ephemeral`       | Yes             | 0.3    | `[novo, baixa confiança]`   |
| 4 | `observed`        | Yes             | 0.5    | `[observado]`               |
| 5 | `reinforced`      | Yes             | 0.7    | `[reforçado]`               |
| 6 | `verified`        | Yes             | 0.9    | `[verificado]`              |
| 7 | `active`          | Yes             | 1.0    | `[ativo]`                   |
| 8 | `deprecated`      | No              | 0.0    | —                           |
| 9 | `revoked`         | No (terminal)   | 0.0    | — (antimemory)              |

### 1.2 ALLOWED_TRANSITIONS (Architecture Lock)

```
proposed       → pending_review | ephemeral
pending_review → active | verified | revoked
ephemeral      → observed | deprecated | revoked
observed       → reinforced | deprecated | revoked
reinforced     → verified | deprecated | revoked
verified       → active | deprecated | revoked
active         → deprecated | revoked
deprecated     → revoked
revoked        → (terminal)
```

Changes require founder approval (CODEOWNERS on
`src/control-plane/knowledge-state-machine/transitions.ts`).

### 1.3 Auto-promoter thresholds (Architecture Lock)

| Rule | From → To | Condition | Cron field |
|---|---|---|---|
| 1 | `ephemeral → observed` | `evidence_count >= 1 AND updated_at >= now-24h` | `evidence_threshold:1_in_24h` |
| 2 | `observed → reinforced` | `evidence_count >= 3 AND updated_at >= now-30d` | `evidence_threshold:3_in_30d` |
| 3 | `reinforced → verified` | `evidence_count >= 7 AND updated_at >= now-90d` | `evidence_threshold:7_in_90d` |
| 4 | `verified → active` | `confidence >= 0.9 AND evidence_count >= 10` | `maturity_threshold:conf_0.9_evidence_10` |
| 5 | `ephemeral → deprecated` | `updated_at < now-30d` | `ttl_expired:30d_no_update` |
| 6 | `active → deprecated` | `COALESCE(last_recall_at, updated_at) < now-90d` | `no_usage_90d` |

### 1.4 TTL defaults by kind

| Kind              | Ephemeral TTL | Active/Verified TTL |
|-------------------|---------------|---------------------|
| `memory`          | 30d           | 90d                 |
| `fact`            | 30d           | 90d                 |
| `rule`            | n/a (never ephemeral) | 90d         |
| `behavioral_hint` | 14d           | 60d                 |
| `procedure_hint`  | 14d           | 60d                 |

Override per-call via `input.ttl_days` to `KnowledgeStateMachine.propose()`.

---

## 2. Daily operations

### 2.1 Cron-scheduled worker

`knowledge_state_promoter` runs every hour at `:00`:
- Phase 2 (same fleet as `reflection_batch` / `conversation_summarizer`).
- Wrapped in `runCognitiveModule` (`module='knowledge-state-machine.auto-promoter'`).
- Emits `knowledge_state_promoter.tick.done` with counts per rule.
- Early-returns immediately when `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=false`.

Logs to watch:
- `knowledge_state_promoter.tick.done` (info) — counters per rule.
- `knowledge_state_promoter.tick.degraded` (warn) — non-zero `errors`.
- `knowledge_state_promoter.transition_failed` (error) — single-row failure.
- `knowledge_state_promoter.skipped_illegal_transition` (debug) — benign
  race condition where another tick already moved the row.

### 2.2 Admin UI Proposal Inbox

Pending rows land in `/inbox` (P8.5) with:
- Filter `Type=knowledge` + `Status=pending_review`.
- Risk column shows `lifecycle_transitions[0].risk_score.level`.
- Decision modal exposes `Approve → active`, `Approve → verified`,
  `Reject` — each routes through `KnowledgeStateMachine.transition`
  or `revoke`. Mandatory `comment` field.
- Bulk reject is enabled only for `risk='low'`; `kind='rule'` always
  requires individual decision.

### 2.3 Surface area for owners during canary

Watch for the first 7 days after flag flip:
1. Admin UI Inbox count trending up rather than draining → owner needs
   to review faster; consider broader `Approve` defaults for trusted
   reflection sources.
2. `papel_drift` / `procedure_drift` (P4 detectors) firing because
   active behaviour deviates from the new `verified`/`active`
   distribution.
3. `knowledge_state_promoter.transition_failed` rate >0.1% of rows
   touched — likely indicates a schema drift between the columns the
   worker queries and what the repo facade writes.

---

## 3. Common interventions

### 3.1 Force-revoke knowledge in production

Use `KnowledgeStateMachine.revoke()` from an ad-hoc script — never
edit the row directly. `revoked` is terminal; the row stays in the
table as antimemory.

```typescript
await KnowledgeStateMachine.revoke({
  kind: 'fact',
  proposal_id: '<uuid>',
  reason: 'incident_response: <ticket-id>',
  decided_by: 'incident_response',
});
```

### 3.2 Drain the Inbox in bulk

Bulk approve is **never** allowed for `kind='rule'`. For other kinds:

1. Identify candidates: `SELECT id FROM agent_facts WHERE lifecycle_status='pending_review' AND ...`.
2. Loop transitions individually (preserves audit):

```typescript
for (const id of ids) {
  await KnowledgeStateMachine.transition({
    kind: 'fact',
    proposal_id: id,
    to: 'verified',                  // OR 'active' if direct
    reason: 'bulk_approval:<ticket>',
    decided_by: 'human_approval',
  });
}
```

### 3.3 Re-enable a deprecated row

Allowed transitions from `deprecated` are `[revoked]` — to re-activate,
you must `revoke` the deprecated row and create a fresh proposal. Do
NOT add a `deprecated → active` edge to `ALLOWED_TRANSITIONS` without
founder approval (Architecture Lock).

---

## 4. Architecture Lock — change protocol

Any change to:
1. `ALLOWED_TRANSITIONS` keys or values.
2. `decideInitialStatus` rules / order.
3. Auto-promoter thresholds (1/24h, 3/30d, 7/90d, 0.9/10, 30d/90d TTL).
4. `VISIBILITY_TABLE` entries (visible / weight / label).
5. `KnowledgeStateMachine.propose / transition / revoke` public contract.

requires:
- PR review from founder (CODEOWNERS gate).
- Property test update (BFS in
  `tests/unit/ksm-transitions.spec.ts` must continue to pass).
- Runbook §1.2 / §1.3 sync.

---

## 5. Feature flag — `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`

| Flag | Tools | Workers | `save_fact` / `save_rule` |
|------|-------|---------|---------------------------|
| `false` | `propose_*` still registered but never recommended in prompts | early-return | legacy `factsRepo.upsert` / `rulesRepo.create` directly |
| `true`  | `propose_*` is the recommended path; LLM picks via prompt | runs every 1h | wrapper → `propose_*`, emits `deprecation_warning_save_*` |

**Rollout:**
1. Week 1 — staging only.
2. Week 2 — 1 tenant canary in prod.
3. Week 3 — 10% prod.
4. Week 4 — 100% prod.
5. P11 — drop `save_fact` / `save_rule` aliases.

Kill-switch: set `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=false` and restart;
`save_*` tools fall back to legacy paths, worker early-returns. Rows
already in `pending_review`/`ephemeral` remain in place — they continue
to be filtered out of the LLM's view because the visibility predicate
runs at slice-builder time regardless of the flag.

---

## 6. Acceptance gates

Run before each rollout step:

```bash
bash scripts/acceptance/p10a-knowledge-state-machine.sh
```

All 12 gates must pass. Failing gates indicate that one of the
Architecture-Lock invariants has been weakened — escalate to founder
before proceeding.

---

## 7. Known limits + follow-ups

1. **Evidence model.** `evidence_count` is currently maintained by the
   reflection batch + tool callbacks via direct SQL `evidence_count =
   evidence_count + 1`. A dedicated `KnowledgeStateMachine.markEvidence`
   API (with idempotency by `evidence_id`) is deferred to P10a.1.
2. **`last_recall_at`.** The auto-promoter falls back to `updated_at`
   when `last_recall_at` is null. The recall path (`recall_memory`
   tool / slice builder) must update `last_recall_at` for rule 6 to
   trigger; current path does not — covered in a follow-up ticket.
3. **`revoked` antimemory injection.** §8 of the spec proposes
   injecting `revoked` keys as `knowledge_known_to_be_false` into the
   system prompt. Deferred to P10b/P11.
4. **Tenant-level TTL overrides.** Defaults live in code; per-tenant
   overrides via `tenant_settings.knowledge_ttl_overrides` deferred to
   v2.
