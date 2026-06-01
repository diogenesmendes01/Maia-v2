# Governance + Observability

> Rules, audit, metrics, trace. Spans `governance`, `control-plane`, `admin-ui`, and observability primitives in `lib`.

## 1. The invariant

**Every decision the system makes is auditable, every approval is owner-driven, every behavior change is versioned.** Governance is not a feature; it's the precondition under which the system is allowed to act. The agent generates evidence; humans (or owner-defined policy) approve evolution.

Concretely:

- **Audit**: every side-effect and every policy decision writes an `audit_logs` row with action label, tenant attribution, and the data the rule was applied to.
- **Approvals**: any irreversible action goes through dual-approval; any new capability/skill/procedure proposed by the agent goes through owner gating in the admin-ui.
- **Observability**: every metric has `tenant_id + agent_id` labels so a noisy tenant is distinguishable from many tenants each within quota.
- **Trace**: every turn has a dual-pattern runtime trace (sync envelope + async body) so failures are reconstructable.

## 2. Why it matters

In a configurable agent platform, *"the model decided"* is not a defensible audit trail. Owners, auditors, and downstream tooling all need to know which rule, applied to which payload, by which agent, on whose behalf, produced which side-effect.

Observability with tenant attribution is the operational corollary: a dashboard that shows "rate-limit overage went up" without per-tenant attribution can't tell whether one tenant is misbehaving or all of them are. The metrics labels turn aggregate noise into actionable diagnosis.

## 3. Where it lives in code

### Governance (`src/governance/`)

| File | Role |
|---|---|
| `src/governance/audit.ts` | `audit()` — the single audit writer; injects ALS context, falls back to synthetic `system` for tenant-less paths, emits per-action + tenant counter |
| `src/governance/audit-actions.ts` | Audit action enum — the typed taxonomy of what can be audited |
| `src/governance/audit-mode.ts` | Audit mode (live/silent/test) for offline scenarios |
| `src/governance/rules.ts` | Rule engine over typed intents |
| `src/governance/dual-approval.ts` | Dual-approval state machine for irreversible actions |
| `src/governance/idempotency.ts` | Idempotency cache (per-tenant + key) for side-effecting tools |
| `src/governance/lockdown.ts` | System-wide lockdown gate (governance pause) |
| `src/governance/permissions.ts` | Permission matrix (pessoa × entidade × profile) |
| `src/governance/policy-dsl/index.ts` | Policy DSL — declarative governance rules |
| `src/governance/policy-dsl/validator.ts` | Schema-validates DSL inputs |
| `src/governance/policy-dsl/evaluator.ts` | Evaluates DSL against typed payloads |
| `src/governance/policy-dsl/enforcement.ts` | Applies evaluator verdict to actions |

### Control plane — knowledge + drift + trace (`src/control-plane/`)

| File | Role |
|---|---|
| `src/control-plane/knowledge-state-machine/state-machine.ts` | 9-state KSM lifecycle for learned knowledge |
| `src/control-plane/runtime-trace/envelope-writer.ts` | Sync envelope writer — per turn, durable, observable |
| `src/control-plane/runtime-trace/body-writer.ts` | Async body writer — detailed trace, redacted, encrypted |
| `src/control-plane/runtime-trace/lib/redaction.ts` | PII redaction for trace bodies |
| `src/control-plane/runtime-trace/lib/hmac.ts` | HMAC chain for trace integrity |
| `src/control-plane/runtime-trace/lib/debug-encrypt.ts` | Optional debug-time encryption |
| `src/control-plane/soul/soul-biases-repo.ts` | Append-only soul layer (behavioral biases per agent) |
| `src/control-plane/soul/origin-gate.ts` | Gates soul writes by origin (governance only) |

### Cognition — drift detection (`src/cognition/drift/`)

| File | Role |
|---|---|
| `src/cognition/drift/index.ts` | Drift detector entry — 7 detector types |
| `src/cognition/drift/linguagem.ts`, `tom.ts`, `escopo.ts`, `papel.ts`, `confianca.ts`, `valores.ts`, `soul.ts`, `procedimento.ts`, `vies.ts` | Per-type detectors |
| `src/cognition/drift/decision-engine.ts` | Decision over drift signals → alert / proposal / silent |
| `src/cognition/gap-escalation/engine.ts` | 4-level escalation: silent → dashboard → mentionable → proposed |

### Observability (`src/lib/`)

| File | Role |
|---|---|
| `src/lib/logger.ts` | Pino structured logger |
| `src/lib/metrics.ts` | `incCounter()`, `observeHistogram()`, `setGauge()` — Prometheus-compatible registry |
| `src/lib/alerts.ts` | Alert channels (email / Telegram) |

### Admin UI (governance surface)

| Path | Role |
|---|---|
| `src/admin-ui/` | Next.js 14 + tRPC + NextAuth; 16 routers including: agents, audit, capabilities, channelPolicies, drift, inbox, knowledge, llmSettings, procedures, proposals, skills, tenants, tools-catalog, traces, versions, dashboard |

## 4. Patterns

### 4.1 Single audit entry point with synthetic `system` fallback

`audit()` in `src/governance/audit.ts:27` is the only audit writer. It:

1. Captures the active ALS context via `tryGetCurrentContext()`.
2. If a context is present, writes the row inside it and emits a counter labeled with `tenant_id + agent_id`.
3. If no context (setup, baileys pairing, startup, worker bootstrap), wraps the write in a synthetic `runWithTenantContext({ tenant_id: 'system', agent_id: 'system' }, ...)` so the row is preserved with a visible `system` label.

The fail-path counter uses the *caller's* captured context (not `system`), so an in-tenant DB error doesn't get mis-labeled.

### 4.2 Typed audit taxonomy

`audit-actions.ts` exports the enum of every audit action. The `acao` field on `audit()` is typed; you can't audit an action that doesn't exist in the enum. This makes the audit row a discriminated union — dashboards filter by action label without parsing free-text.

### 4.3 Metrics with `tenant_id + agent_id` labels (every counter, every histogram)

After PR #275, every `maia_*` counter has `tenant_id` and `agent_id` labels. Out-of-context paths use `system`. This means:

- `maia_audit_events_total{action="rate_limit_exceeded", tenant_id="t1", agent_id="a1"}` distinguishes "tenant t1's agent a1 hit rate-limit" from "global rate-limit storm"
- Dashboards that previously aggregated by `sum without (tenant_id, agent_id)` keep working; new per-tenant dashboards are now possible

### 4.4 Dual-pattern runtime trace (sync envelope + async body)

`envelope-writer.ts` writes a small, durable envelope per turn (turn_id, tenant, agent, timestamp, outcome). The full body (detailed steps, prompts, results) is written async by `body-writer.ts`. This means:

- A turn outcome is observable even if the body write fails or is delayed
- HMAC chains the envelope to the body so tampering is detectable
- Redaction and optional encryption apply to the body, not the envelope

### 4.5 Drift detector — 7 types × 4 severities

`src/cognition/drift/index.ts` invokes 7 typed detectors. Each detector returns a severity (1-4) for its category. The drift decision engine (`decision-engine.ts`) maps the matrix of severities to an action: silent, dashboard alert, mentionable, or owner-proposed correction.

### 4.6 Capability and skill proposals → admin-ui approval

Agent-generated proposals (`capability_proposals`, `skill_proposals`) are owner-approved through the admin-ui. The admin-ui's tRPC routers (`agents`, `capabilities`, `proposals`, `skills`, `procedures`) are the governance surface. The agent never writes to its own operational profile; it only proposes.

### 4.7 Policy DSL for declarative governance

`src/governance/policy-dsl/` lets owners express rules declaratively. The evaluator runs the DSL over typed payloads; the enforcer applies the verdict. This keeps governance rules out of executable code paths — they're data, evaluated.

## 5. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| Direct `INSERT INTO audit_logs` | Bypasses `audit()`'s context capture and counter emission. Use `audit()`. |
| Audit-free side-effect ("just a small change") | Every side-effect audits. There is no small change. |
| Metric without `tenant_id + agent_id` labels | Aggregates lose attribution. Every new counter goes through `incCounter()` with labels. |
| Direct write to `soul_biases` | Soul is append-only and gated by `origin-gate.ts`. Cognition proposes; governance writes. |
| Direct mutation of `agent_operational_profile` | Operational profile is governed. Use proposal flow (admin-ui approval). |
| Lockdown bypass for "emergency" | Lockdown is the emergency. Bypassing it negates the gate. |
| Free-text audit action (`acao: "thing happened"`) | The enum is the taxonomy. Add a new variant to `audit-actions.ts` and use it. |
| Trace body without redaction | PII goes through `lib/redaction.ts`. Raw bodies are not durable. |

## 6. Tests

| Test path | What it proves |
|---|---|
| `tests/unit/audit-rate-limit-tenant-labels.spec.ts` | Counters carry tenant labels |
| `tests/unit/audit-tenant-fallback.spec.ts` | `system` fallback for out-of-context audits |
| `tests/unit/governance/idempotency.spec.ts` | Idempotency cache scoped by tenant + key |
| `tests/unit/governance/dual-approval.spec.ts` (if present) | Dual-approval state transitions |
| `tests/unit/governance/policy-dsl/` | DSL evaluator + enforcement |
| `tests/unit/constitutional.spec.ts` | Constitutional rules are non-negotiable |
| `tests/integration/p10b-runtime-trace.spec.ts` (if present) | Envelope/body trace integrity |
| `tests/unit/control-plane/knowledge-state-machine/` | KSM lifecycle + transitions |
| `tests/unit/cognition/drift/` | Drift detector contracts |

## 7. Known gaps

Re-verify at read time.

To find current gaps:

```bash
gh issue list --label "governance"
gh pr list --state open --search "audit OR governance OR trace"
```

At last verification:

- P3c (procedure governance ops) — partial: `procedure_metrics` materialized view, full test runner, full step-evaluator (`llm_judge` / `user_signal` / `human_confirmed`) still in iteration. See `README.md` § Estado atual.
- Runtime-trace P10b — implemented; admin-ui trace exploration still maturing.
- Capability dialogical-acquisition 4-level escalation — in production; loop closure post-acquisition still being tuned.

## 8. In-flight changes

At last verification (2026-05-28):

- Metrics: rate-limit counter `tenant_id+agent_id` labels (#275 — merged)
- Audit `system` fallback for tenant-less paths (#275 follow-up — merged)
- Outbound idempotency ledger to close double-send (#227 → #233 → #238 — merged + open)
- Governance idempotency cache scope by `tenant_id+agent_id` (#261 → #273 — open)
- KSM per-row context wraps audit module (#255 → #280 — open)
- KSM bounded retry loop for revoke under optimistic-conflict (#256 → #279 — open)
- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)

Verify with `gh pr list --state open --search "audit OR governance OR trace OR idempotency"`.

## 9. Key decisions

- **Single audit entry point with synthetic `system` fallback** — `audit()` writes inside ALS context or wraps in `system` for tenant-less paths. No row is lost; no row is misattributed.
- **Typed audit taxonomy (enum, not free-text)** — `audit-actions.ts` is the discriminated union; dashboards filter on action label without parsing.
- **Tenant labels on every counter** — `maia_*_total{action, tenant_id, agent_id}` is the standard. Out-of-context = `system`.
- **Dual-pattern trace (envelope + body)** — envelope is durable + observable; body is detailed + redacted + HMAC-chained.
- **Cognition proposes; governance gates** — every capability/skill/procedure/role change goes through proposal + owner approval. No self-modification.
- **Policy DSL over imperative checks** — declarative rules in `policy-dsl/` keep governance out of executable code paths.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | Older than 30 days; OR `audit-actions.ts` adds a variant; OR `metrics.ts` changes counter labels; OR `runtime-trace/` changes envelope/body split; OR `policy-dsl/` adds an operator |
