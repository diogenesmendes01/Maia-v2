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

### Observability (`src/lib/`, `src/observability/`)

| File | Role |
|---|---|
| `src/lib/logger.ts` | Pino structured logger |
| `src/lib/metrics.ts` | `incCounter()`, `observeHistogram()`, `setGaugeProvider()` — Prometheus-compatible registry (the **transport**) |
| `src/lib/alerts.ts` | Alert channels (email / Telegram) |
| `src/observability/taxonomy.ts` | **Issues #514 + #535** — canonical span tree + **emission status per span**, metric names, label/span-attribute allow-deny lists, cardinality budgets |
| `src/observability/labels.ts` | Label sanitizer — the fail-closed gate between instrumentation and the registry |
| `src/observability/span-attributes.ts` | **#535** — the same gate for OTLP span attributes (one deliberate divergence: correlation ids are allowed) |
| `src/observability/metrics.ts` | Sanitized emitters (`counter`/`histogram`/`gauge`) — the **policy layer** over `lib/metrics.ts` |
| `src/observability/correlation.ts` | Correlation ALS — one `trace_id` per turn, propagated ingress → queue → worker → decision → trace → logs |
| `src/observability/tracer.ts` | **#535** — span emission: W3C ids derived from the Maia `trace_id`, derived head sampling, ALS parent chain |
| `src/observability/otlp-exporter.ts` | **#535** — dependency-free OTLP/HTTP JSON exporter: bounded queue, batching, counted loss |
| `src/observability/instrumentation.ts` | **#535** — `instrumentToolDispatch` / `instrumentContextLoad` wrappers |
| `src/observability/runtime-collectors.ts` | **#535** — pg pool, WhatsApp session, scheduler-lag gauges |
| `src/observability/register.ts` | **#535** — single wiring point, called once from `src/server.ts` |
| `src/observability/turn-trace.ts` | Adapter connecting the durable P10b `trace()` to the hot path |
| `src/observability/queue-metrics.ts` | Queue depth + oldest-job-age gauges |
| `src/observability/turn-state-collector.ts` | Live turn count + per-state age gauges (#503) |
| `src/lib/llm/telemetry.ts` | LLM call/latency/token/failure counters (the gateway owns them since #508) |
| `src/observability/redis-memory-collector.ts` | Redis memory pressure gauges (#297) |
| `monitoring/alerts/slo.rules.yml` | Recording rules, 27 alerts, error-budget burn rate |
| `monitoring/dashboards/` | **#535** — three versioned Grafana dashboards (correção · capacidade · ação) |
| `docs/runbooks/observability-slo.md` | SLIs/SLOs, per-alert operator reaction, clock semantics, OTLP rollout |

### Admin UI (governance surface)

| Path | Role |
|---|---|
| `src/admin-ui/` | Next.js 16 + React 19 + tRPC + NextAuth; 16 routers including: agents, audit, capabilities, channelPolicies, drift, inbox, knowledge, llmSettings, procedures, proposals, skills, tenants, tools-catalog, traces, versions, dashboard |

## 4. Patterns

### 4.1 Single audit entry point with synthetic `system` fallback

`audit()` in `src/governance/audit.ts:27` is the only audit writer. It:

1. Captures the active ALS context via `tryGetCurrentContext()`.
2. If a context is present, writes the row inside it and emits a counter labeled with `tenant_id + agent_id`.
3. If no context (setup, baileys pairing, startup, worker bootstrap), wraps the write in a synthetic `runWithTenantContext({ tenant_id: 'system', agent_id: 'system' }, ...)` so the row is preserved with a visible `system` label.

The fail-path counter uses the *caller's* captured context (not `system`), so an in-tenant DB error doesn't get mis-labeled.

### 4.2 Typed audit taxonomy

`audit-actions.ts` exports the enum of every audit action. The `acao` field on `audit()` is typed; you can't audit an action that doesn't exist in the enum. This makes the audit row a discriminated union — dashboards filter by action label without parsing free-text.

**A declared action is not a produced action.** The enum being typed stops you
from auditing a *non-existent* action; it does not stop you from declaring one
nobody emits. `llm_circuit_opened` / `llm_circuit_closed` shipped in the enum
with a matching `audit-watcher` rule (`llm_circuit_long_open`) and **no
producer** — `grep -rn "audit(" src/lib/llm/` returned zero, so the durable
"breaker open for >5 min" alert could never fire, and its silence was
indistinguishable from "nothing happened". Closed in the PR #541 review by
`src/lib/llm/circuit-audit.ts`. When you add an action, add the emitter in the
same change, and prove the ROW lands (see §4.2b).

### 4.2b Proving an audit row LANDED, not that `audit()` was called

`audit()` swallows failures by design (log + `maia_audit_write_failed_total`,
no propagation) so a transient DB hiccup can't break business logic. That makes
a mock-based audit test structurally weak: it stays green for a write that never
committed.

The concrete trap in this repo: `audit_log.alvo_id` is **UUID**
(`migrations/001_initial.sql`). Any caller that puts a TEXT identifier there
gets an INSERT error, `audit()` eats it, and the row silently disappears. It has
already happened twice. Rules:

1. Check the COLUMN TYPE before choosing a field. Free-text targets go in
   `entidade_alvo` (TEXT) + `metadata` (JSONB); `alvo_id` is for real uuids.
2. For any new audit producer, the regression test asserts against **real
   Postgres** that the row exists — `tests/integration/llm-circuit-audit-real-db.spec.ts`
   is the reference shape.
3. If the write is fire-and-forget (hot path), expose a drain
   (`drainCircuitAudits()`) so the test can await it instead of sleeping.

### 4.2c Fleet-level decisions audit under `system`, explicitly

Some governance decisions are about the FLEET, not a tenant: circuit-breaker
transitions, and flipping the LLM circuit kill switch. They happen inside some
tenant's call, so `audit()`'s automatic `system` fallback does NOT apply — the
ALS context is populated, and the row would inherit whichever tenant happened to
be in flight. That is a false attribution, which is worse than none.

Such producers wrap the write in `runWithSystemContext()` **explicitly**, and
justify it against the four cumulative conditions of
[`ADR 0002`](../decisions/0002-external-dependency-health-is-system-state.md).
The per-decision attribution does not disappear — it lives where the individual
consequence is emitted (`maia_llm_requests_total{status="circuit_open"}` carries
`tenant_id + agent_id`). Global state, scoped evidence.

### 4.3 Metrics with `tenant_id + agent_id` labels (every counter, every histogram)

After PR #275, every `maia_*` counter has `tenant_id` and `agent_id` labels. Out-of-context paths use `system`. This means:

- `maia_audit_events_total{action="rate_limit_exceeded", tenant_id="t1", agent_id="a1"}` distinguishes "tenant t1's agent a1 hit rate-limit" from "global rate-limit storm"
- Dashboards that previously aggregated by `sum without (tenant_id, agent_id)` keep working; new per-tenant dashboards are now possible

### 4.4 Dual-pattern runtime trace (sync envelope + async body)

`envelope-writer.ts` writes a small, durable envelope per turn (turn_id, tenant, agent, timestamp, outcome). The full body (detailed steps, prompts, results) is written async by `body-writer.ts`. This means:

- A turn outcome is observable even if the body write fails or is delayed
- HMAC chains the envelope to the body so tampering is detectable
- Redaction and optional encryption apply to the body, not the envelope

### 4.4a `envelope_hmac` is versioned: `signature_version` (issue #535)

The envelope signature has **two versions**, and which one a row uses is a
column (`runtime_trace_envelopes.signature_version`, migration 119).

| | v1 | v2 |
|---|---|---|
| Signed fields | `trace_id`, `tenant_id`, `agent_id`, `conversa_id`, `turno_id`, `policy_id`, `decision`, `side_effect_level`, `redaction_class`, `hmac_key_version` | v1 **∪** `root_trace_id`, `attempt`, `signature_version` |
| Written by production | **no** — never again | **yes**, always |
| Read by the verifier | yes (fixtures / old environments) | yes |
| Re-signed retroactively | **no** | — |

Both materials are built in one file,
[`src/control-plane/runtime-trace/lib/signature.ts`](../../../src/control-plane/runtime-trace/lib/signature.ts),
so signer and verifier cannot drift.

**Why now.** Migration 107 left `root_trace_id`/`attempt` outside the signature
on the argument that signing them would invalidate every envelope already
written. `FEATURE_RUNTIME_TRACE_V1` has never been on in production, so there is
no corpus to invalidate — this was the last cheap window to fix the contract.

**Why this is not a downgrade attack.** The version lives in a column, and a
column is what an attacker with DB write access controls. The v2 material
therefore contains `"signature_version":2` — explicit domain separation. Flipping
a v2 row's column to `1` makes the verifier recompute the *v1* material and
compare it against an HMAC taken over the *v2* material: it cannot match, and
the row reads `invalid`. Relabelling in the other direction is detected the same
way.

**What remains open.** A row that is *genuinely* v1-signed still has
`root_trace_id`/`attempt` outside its signature, so on such rows those two
columns are editable without detection. Two defences, both independent of the
signature:

- `RUNTIME_TRACE_ACCEPT_SIGNATURE_V1=false` refuses v1 **at read time**. The
  verdict is `rejected_version` — deliberately distinct from `invalid`, because
  a v1 signature may be perfectly genuine and calling it tampering is the same
  category error the old `hmac.length > 0` check made, in reverse. Default is
  `true`; turn it off in an environment confirmed to hold no v1 rows.
- `listAttempts()` requires the **signed `turno_id`** (§4.4b below), which is
  inside the signature in *both* versions.

### 4.4b Correlation: one `trace_id` per turn (issue #514)

`src/observability/correlation.ts` owns a dedicated AsyncLocalStorage, separate
from the tenant ALS on purpose: tenant context is **fail-closed** (missing ⇒
throw, it is a security boundary), correlation is **fail-soft** (missing ⇒
`null`, observability must never break a turn). Merging them would force one
semantics onto the other.

The id is **derived, not minted**: `deriveTraceId(mensagem_id)` returns a UUID
seed verbatim and hashes anything else into a stable v5-shaped UUID. That is
what makes "recovery preserves the root trace" free — the sweep re-enqueues the
same row id and lands on the same trace, with no state carried across the
crash. Each attempt gets its own `attempt` ordinal + `attempt_id`, so a retry
is distinguishable without splitting the trace.

Context builders must **not** mint a new root (`build-base-context.ts:83`,
`base-context-builder.ts:132` both read the ambient id first).

**Grouping attempts requires the signed `turno_id` (issue #535).**
`runtimeTraceRepo.listAttempts()` takes `{ tenantId, rootTraceId, turnoId }` —
all three required — and:

1. **fails closed** (`TraceAttemptScopeError`) when `turnoId` is blank or
   absent, rather than falling back to grouping on `root_trace_id` alone. A
   fallback would be the control switched off by omitting an argument;
2. filters on `turno_id` **in the SQL**, served by
   `runtime_trace_env_attempt_turn_idx` (migration 119);
3. **drops** a returned sibling whose own envelope verifies as `invalid`.
   `unknown` and `rejected_version` are reported, not hidden — a row an
   operator can already see in the list view must not silently vanish from the
   group.

This is **defence in depth**, not the primary control: the primary control is
that v2 signs `root_trace_id` and `attempt`. This layer is what still holds on a
v1 row. What it buys is the property the owner named — two distinct turns can
never render as attempts of one, because joining a group now requires agreeing
on a field that every version signs.

`tracesRouter.getTrace` only builds the group when the row it is showing has a
`root_trace_id`, has a `turno_id`, and did not itself verify as `invalid`;
otherwise the attempt list is empty (degraded grouping, never a merged one).

### 4.4c Metric labels are a closed allowlist (issue #514 §6)

`src/observability/labels.ts` is a gate, not a convention:

| Rule | Behaviour |
|---|---|
| key not on the allowlist | dropped |
| key on the deny list, or containing `phone`/`jid`/`email`/`message`/`trace_id`/… | dropped — the deny list wins over the allowlist |
| value shaped like a phone / JID / e-mail / URL / free text | `__sanitized__` |
| value past the (metric, key) cardinality budget | `__overflow__` |

`tenant_id` + `agent_id` are the sanctioned exception (§4.3 above), still
cardinality-capped. High-cardinality correlation ids live in **logs and
traces** — `correlationLogFields()` for logs, `span-attributes.ts` for OTLP
spans (issue #535) — never in labels. Nothing throws in
production; `MAIA_STRICT_METRIC_LABELS=true` promotes a violation to a test
failure. Both that flag and `FEATURE_RUNTIME_TRACE_V1` are declared in the
configuration contract (`src/config/contract.ts`, issue #515) and read through
the typed loader — never `process.env` — so both are validated at boot and
`restartRequired`.

### 4.4d Two trace surfaces, one id (issue #535)

There are now **two** traces, and conflating them is the mistake to avoid:

| | Durable trace (P10b) | Operational trace (OTLP) |
|---|---|---|
| Purpose | governed evidence | latency waterfall |
| Storage | `runtime_trace_envelopes/_bodies` | third-party collector |
| Sampling | never | `MAIA_OTLP_SAMPLE_RATIO`, default 5% |
| Integrity | HMAC-chained | none — it is not a system of record |
| Off switch | `FEATURE_RUNTIME_TRACE_V1` | absent `MAIA_OTLP_TRACES_ENDPOINT` |

They **join on one id**: the W3C trace id is `mensagens.id` with the dashes
removed, so one value addresses the durable envelope, the log line, the Trace
Explorer and the collector. `tracer.ts` derives it rather than minting a
parallel id, for the same reason `deriveTraceId` is derived: an id you have to
carry is an id you can lose.

Sampling is **derived from the trace id, never rolled**. A turn crosses
processes (ingress → BullMQ → worker); if each rolled its own dice we would
export half-traces, and a missing half reads as "that stage never ran". Hashing
the id makes every process reach the same verdict with nothing to propagate.

The taxonomy can no longer overstate coverage: `SPAN_EMISSION` marks each span
`emitted` or `declared`, and `tests/unit/observability/tracer.spec.ts` fails if
the two drift. **Every span in the taxonomy is now `emitted`** — the owner's
ruling on #535 was that a span living only in the declaration is debt, so the
nineteen names that had none either got a real emitter on the production path or
left the taxonomy with an individual written reason
(`SPANS_REMOVED_IN_535`: `ingress.normalize`, `ingress.persist`,
`whatsapp.send`, all three removed because the `turn` span they were declared
under does not overlap them in time). A separate case asserts the `declared` set
is empty, so "we will wire it later" cannot re-enter through the table.

`emitted` means **production reaches this span** — not "an instrumentation site
exists in the tree". The review of PR #554 settled that reading and it is the
strict one on purpose: this table is read as a coverage answer, and a span no
turn can open produces nothing. `context.load` is the case that forced the
distinction; it is emitted by `loadTurnContext`
(`src/agent/turn-context/loader.ts`) on the turn's own path, and
`tests/integration/context-load-span-hot-path.spec.ts` drives the real entry
point (`runAgentForMensagem`) to prove it rather than asserting the table
against itself.

#### Span attribution is RESOLVED, not read at close

Every exported span carries `tenant_id + agent_id`, and the tuple is the one
the turn **resolved to** — not whatever ALS happened to hold when the span
closed. The distinction is not academic: it was the defect. The root `turn`
span is opened by the worker BEFORE the tenant is known (`src/gateway/queue.ts`
wraps the processor in the sanctioned `system` context) and `src/agent/core.ts`
opens the real `runWithTenantContext` NESTED inside it. That nested scope has
already unwound by the time the root's `emit()` runs after its `await`, so a
close-time ALS read returned `system` for **every root span ever exported**,
while `tool.dispatch` — opened inside the resolved scope — reported the truth.
A waterfall whose root could not be filtered by tenant, and whose children
disagreed with it.

So the tuple is CAPTURED instead, and it is published **by whoever resolves
it** — `src/agent/core.ts`, right after deriving `resolved` and *before*
entering `runWithTenantContext` — via `publishSpanAttribution`, which stamps
every span open on that async context; `emit()` uses the captured value.

There is deliberately **no extension point in `src/db/tenant-context.ts`**.
A first attempt installed a generic observer there; it was rejected on review,
for a reason worth keeping written down: that module validates the tuple at
*read* time (`assertTruthyContext`, `assertNotDefaultLiteral` inside
`getCurrentTenant()`/`getCurrentAgent()`), not at scope entry. A hook on entry
would therefore stamp spans with tuples that had passed no validation at all —
including the `'default'` literal that `AGENTS.md` §4 rule 8 bans — while a
read of the same context would throw. Telemetry would assert precisely what the
invariant forbids. The fail-closed boundary stays free of extension points; new
resolution sites publish explicitly.

Two rules keep the isolation invariant intact, and both are test-enforced:

- **`system` never publishes.** The worker's outer `runWithSystemContext` — in
  either nesting order — cannot downgrade a span that already resolved.
- **A span's tuple is write-once.** A second, *different* real tenant seen
  under the same span is an anomaly, not an update; re-stamping would put one
  tenant's tuple on another tenant's span. It is counted as
  `maia_span_attribute_rejected_total{reason="attribution_conflict"}` and
  dropped.

Concurrency safety is structural rather than defensive: the slot lives on the
per-span object created inside the tracer's own ALS frame, so two jobs of
different tenants never touch the same object.
`tests/unit/observability/span-attribution.spec.ts` and
`tests/unit/gateway/queue-span-attribution.spec.ts` assert the **exported**
attribution (what reaches the sink), including the concurrent case.

`queue.wait` is the one span that cannot learn its own tenant: it reconstructs
a window that closed before the worker existed. It is therefore emitted after
the root closes, stamped with the tuple the root resolved to. The matching
`maia_queue_wait_ms` **histogram** is still recorded up front, before the
tenant is known, and is therefore still labelled `system` — deliberately, so
the queue-wait SLI survives a turn that never finishes.

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
| `incCounter()` directly for a NEW metric | Bypasses the label sanitizer. Use `src/observability/metrics.ts` and declare the name in `taxonomy.ts` first. |
| `conversa_id` / `trace_id` / phone as a metric label | Unbounded cardinality + PII. Put it in the log line (`correlationLogFields()`) or the span attribute (`span-attributes.ts`), never the label. |
| Free text (a policy reason, an error message) as a span attribute | The collector is a third party. `span-attributes.ts` replaces it with `__sanitized__`; the detail belongs in the log line. |
| Marking a span `emitted` in `SPAN_EMISSION` without an emitter | This is the exact defect issue #535 opens with — a declaration that reads as coverage. The tracer spec fails on it. |
| Treating a returned `{ error }` from `dispatchTool` as success | The dispatcher signals denial by RETURNING. Classify with `classifyToolResult`, or the tool SLI reads 0% while the agent cannot act. |
| Reading a missing pool/session/scheduler gauge as a healthy 0 | Every #535 collector renders `NaN` when it cannot read its source; `Maia*MetricsAbsent` exists for this. |
| Minting a fresh `trace_id` inside a context builder | Splits one turn into several traces. Read `currentTraceId()` first. |
| Reading an absent metric as a healthy `0` | A gauge that cannot be read renders `NaN` on purpose. `MaiaQueueMetricsAbsent` exists for this. |
| Relaxing the label sanitizer to fix a cardinality alert | Fix the call site. The sanitizer is the invariant, not the symptom. |
| Audit-free side-effect ("just a small change") | Every side-effect audits. There is no small change. |
| Metric without `tenant_id + agent_id` labels | Aggregates lose attribution. Every new counter goes through `incCounter()` with labels. |
| Direct write to `soul_biases` | Soul is append-only and gated by `origin-gate.ts`. Cognition proposes; governance writes. |
| Direct mutation of `agent_operational_profile` | Operational profile is governed. Use proposal flow (admin-ui approval). |
| Lockdown bypass for "emergency" | Lockdown is the emergency. Bypassing it negates the gate. |
| Free-text audit action (`acao: "thing happened"`) | The enum is the taxonomy. Add a new variant to `audit-actions.ts` and use it. |
| Adding an audit action (or a watcher rule) without an emitter in the same change | A declaration that reads as coverage. `llm_circuit_opened`/`llm_circuit_closed` sat in the enum with a live watcher rule and no producer — a durable alert that could never fire. See §4.2. |
| Proving an audit with a mocked `audit()` | `audit()` swallows failures. The test stays green for a row that never committed (the `alvo_id` uuid trap). Assert against real Postgres — §4.2b. |
| Letting a FLEET-level decision inherit the ambient `tenant_id` | The breaker/kill-switch state is not any tenant's. Wrap in `runWithSystemContext()` explicitly and argue it against ADR 0002 — §4.2c. |
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
| `tests/unit/observability/labels.spec.ts` | PII/cardinality label gate (issue #514) |
| `tests/unit/observability/taxonomy.spec.ts` | Span tree shape + metric naming discipline |
| `tests/unit/observability/correlation.spec.ts` | Deterministic trace derivation, ALS isolation, attempts |
| `tests/unit/observability/turn-trace.spec.ts` | Envelope fail-loud semantics + body privacy |
| `tests/unit/observability/slo-rules.spec.ts` | Alert rules ↔ emitted metrics drift guard |
| `tests/unit/observability/runtime-trace-repo.spec.ts` | Trace Explorer tenant fail-closed + keyset cursor |
| `tests/unit/observability/span-attributes.spec.ts` | Span-attribute gate: PII out, correlation ids in (issue #535) |
| `tests/unit/observability/tracer.spec.ts` | Inert-when-off, id correlation, derived sampling, taxonomy honesty |
| `tests/unit/observability/span-attribution.spec.ts` | EXPORTED span attribution: resolved tenant on the root, write-once, concurrent turns never swap tuples |
| `tests/unit/gateway/queue-span-attribution.spec.ts` | Same, driven through the real BullMQ handler — `turn` + `queue.wait` agree |
| `tests/unit/observability/otlp-exporter.spec.ts` | OTLP wire contract + bounded/counted loss |
| `tests/unit/observability/runtime-collectors.spec.ts` | pool/session/scheduler gauges render NaN, never a healthy 0 |
| `tests/unit/observability/instrumentation.spec.ts` | Returned `{error}` is classified, not counted as success |
| `tests/unit/observability/llm-request-span.spec.ts` | `llm.request` reaches the OTLP wire from the real `executeLLM`, on every outcome |
| `tests/unit/observability/dashboards.spec.ts` | Dashboards ↔ emitted metrics / recording rules drift guard |
| `tests/unit/observability/overhead-benchmark.spec.ts` | Per-emission cost + cardinality budget actually bounds series |
| `tests/unit/scripts/otlp-overhead-benchmark.spec.ts` | The OTLP-on A/B gate REFUSES: every named criterion goes red under injection, `skipped ⇒ passed=false`, report encoding (issue #535 §4) |
| `scripts/otlp-overhead-benchmark.ts` (`npm run otlp:bench`) | Not a spec — the measurement itself. **Real Postgres**, real turns through the worker entry point, arms `off` / `on-local` / `on-slow` alternated in one process, `MAIA_OTLP_SAMPLE_RATIO=1`; 10 % relative gate on p95/p99/throughput, counted loss, bounded queue, real `/metrics` series delta. Floor, not production (synthetic LLM + channel) |
| `tests/admin-ui/unit/traces-router.spec.ts` | Trace Explorer tenant scoping + NOT_FOUND (not FORBIDDEN) |
| `tests/integration/observability-hot-path-trace.spec.ts` | Hot-path trace through the real HMAC/redaction writers |
| `tests/integration/llm-circuit-audit-real-db.spec.ts` | **Real Postgres** — a circuit transition LANDS a row in `audit_log` under `system`, `alvo_id` stays null, and the `llm_circuit_long_open` watcher rule finds the open/closed pair and the stuck case |

## 7. Known gaps

Re-verify at read time.

To find current gaps:

```bash
gh issue list --label "governance"
gh pr list --state open --search "audit OR governance OR trace"
```

At last verification:

- P3c (procedure governance ops) — partial: `procedure_metrics` materialized view, full test runner, full step-evaluator (`llm_judge` / `user_signal` / `human_confirmed`) still in iteration. See `README.md` § Estado atual.
- Capability dialogical-acquisition 4-level escalation — in production; loop closure post-acquisition still being tuned.

Issue #514 landed the foundation; issue #535 landed the exporter, four of the
five missing metric families and the dashboards. Still open — do **not** assume
coverage that does not exist:

- **Span emission is complete, and three names left to make it true.** Every
  entry in `SPAN_EMISSION` is `emitted`, each with a wiring test that enters
  through a production entry point — `tests/integration/turn-span-tree-hot-path.spec.ts`
  drives `runAgentForMensagem` for the turn tree,
  `tests/unit/tools/dispatcher-gate-spans.spec.ts` drives `dispatchTool` for the
  four gates. What is NOT covered by a turn is stated in that spec rather than
  implied: a text-only turn opens no `tool.dispatch`, and `queue.wait` needs a
  BullMQ job. `ingress.normalize`, `ingress.persist` and `whatsapp.send` were
  removed with per-span reasons in `SPANS_REMOVED_IN_535` — all three sit
  outside the `turn` span's lifetime (the two ingress ones end before it starts;
  the send happens in the delivery worker after it closes), so the parentage the
  tree declared for them is impossible, not merely unimplemented.
- **Three declared parents were corrected to match the code**: `context.load`
  now hangs under `prompt.render` (its emitter is called by `buildPrompt`),
  `outbound.commit` under `react.iteration` (reached from `safeDispatchOutput`
  inside the loop), and `risk.classify` under `decision.evaluate` (the pre-turn
  graph has exactly two nodes, neither of them risk). `isDeclaredAncestor()`
  would have rejected the real runtime parent in all three cases.
- **`llm.request` is emitted from `emitUsage`, not from `executeLLM`.** The
  gateway has six terminal paths and issue #508 already collapsed all of them
  onto one telemetry emission point precisely because per-path emission had let
  error, timeout, rate limit and cancellation count nothing. Binding the span
  there makes "one span per LLM request, on every outcome" structural rather
  than a convention a seventh exit could bypass, and the span window is
  reconstructed from the gateway's own `duration_ms` so it cannot disagree with
  `maia_llm_request_duration_ms`. Like `context.load`, it adds NO metric family:
  `emitUsage` already publishes calls, duration and tokens for the same call,
  so this change adds zero label cardinality. `tests/unit/observability/llm-request-span.spec.ts`
  drives the real `executeLLM` and scrapes the OTLP body the exporter POSTs.
- **`context.load` carries no metric family of its own — by decision.** The
  span is emitted by `loadTurnContext` (`src/agent/turn-context/loader.ts`),
  wrapped at the exported entry point so "once per turn-context load" is
  structural. Duration and round-trips for that same load are published by
  `recordTurnContextLoad` — `maia_turn_context_load_duration_ms{phase,result}`
  and `maia_turn_context_db_queries{phase}` (issue #525). The review of PR #554
  retired `maia_context_load_ms` and `maia_context_slices_total` rather than
  keeping two families for one operation: they had been declared for the P8a
  assembly (`buildContextPacket`), whose hot path PR #406 deleted, so they were
  dashboarded and alerted on while producing zero series.

  The recording rule followed the emitter: `maia:context_load_ms:p95` became
  `maia:turn_context_load_ms:p95` over
  `maia_turn_context_load_duration_ms_bucket`, and panel 7 of
  `monitoring/dashboards/maia-turn-slo.json` reads it by `phase`.
- **`CONTEXT_LOAD_STAGE` is a closed set of one: `turn_context`.** The wrapper's
  parameter is typed `ContextLoadStage`, not `string`, so the closure is a
  compiler rule and not a review convention. Adding a member is a deliberate
  edit in `taxonomy.ts` — which is the friction that keeps a shared label key
  bounded.
- **Runtime trace on the hot path is gated OFF** (`FEATURE_RUNTIME_TRACE_V1`)
  pending the canary rollout in `docs/runbooks/observability-slo.md`.
- **Not yet instrumented**: outbound send duration (`maia_outbound_send_ms`),
  ingress normalize/persist, identity/audience resolution, the ReAct iteration
  boundary (`react.iteration` — so `llm.request` and `tool.dispatch` currently
  attach to `turn` and a multi-iteration turn shows a flat list of model calls
  and tool calls rather than one group per iteration).
- **Overhead is now measured both micro and under load; cardinality under
  REAL production traffic is still not.** `overhead-benchmark.spec.ts` proves
  the per-emission cost and that the budget BOUNDS the series count;
  `scripts/otlp-overhead-benchmark.ts` (`npm run otlp:bench`, issue #535 §4)
  drives real turns with the OTLP exporter ON against a local collector
  (healthy and degraded) and gates the hot path at 10 % relative to `off`,
  reporting the real series delta that THIS traffic mints. By owner decision
  (2026-09-03) real traffic is the post-canary trigger for cardinality
  validation, not a substitute for that pre-canary proof — so the series count
  under production traffic remains an observation to make, not a number this
  repo claims.
- **v1 envelopes remain readable, and on them `root_trace_id`/`attempt` are
  still unsigned** (issue #535, §4.4a). Production writes only v2, so this is
  bounded to fixtures and to environments that already hold v1 rows — but the
  read side accepts v1 by default (`RUNTIME_TRACE_ACCEPT_SIGNATURE_V1=true`),
  and nothing in the code can tell a genuine v1 row from one an attacker
  planted with a key they should not have. Turning the switch off is an
  operator decision per environment, not a code default, because flipping every
  legacy row to `rejected_version` on deploy day would destroy the evidence the
  switch exists to protect.

## 7.5 Documented exception — staging de inbound não-roteado (`inbound_unrouted`)

Spec `2026-07-09-multi-agent-channel-routing-design` §1.4 (modo `strict`): um
inbound cuja LINHA não resolve para nenhum canal ativo não é descartado — é
**estagiado fora de qualquer tenant** (não há tenant a atribuir; descobrir o
dono é exatamente o que falhou). Esta é uma exceção CONSCIENTE ao invariante
de escopo por tenant, mitigada por:

- **Cifragem**: payload selado em envelope AES-256-GCM versionado
  (`src/gateway/staging-crypto.ts`), keyring via `MAIA_STAGING_KEYRING` +
  `MAIA_STAGING_ACTIVE_KEY_ID`; uma chave só sai do keyring quando nenhuma
  row `pending` a referencia (canário no worker `unrouted_recovery`).
- **TTL**: 72h — rows `pending` vencidas viram `expired` (auditadas como
  `inbound_unrouted_expired`), nunca acumulam indefinidamente.
- **Acesso restrito**: só `inboundUnroutedRepo` + o worker de replay tocam a
  tabela; nenhum caminho de leitura de produto a expõe.
- **Trilha completa**: `inbound_staged` → `inbound_unrouted_handed_off` /
  `inbound_unrouted_expired` no audit; o handoff entrega pela pipeline normal
  sob o tenant RESOLVIDO (o dedup por canal de `mensagens` impede entrega
  dupla na corrida com o caminho vivo).

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
- **OTLP without the OpenTelemetry SDK (#535)** — OTLP is a wire format, not a framework. The HTTP/JSON binding is a POST of a plain object; the SDK would add a large dependency tree, own the global tracer and monkey-patch `http`/`pg`/`ioredis` on import. The cost accepted in exchange: no auto-instrumentation, no cross-service context propagation, no protobuf binding.
- **The OTLP trace id IS the Maia trace id (#535)** — a UUID and a W3C trace id are both 16 bytes, so one value addresses four surfaces instead of forcing an operator to correlate two id spaces.
- **Sampling derived from the trace id, not rolled per process (#535)** — a turn crosses processes; independent dice produce half-traces, and a missing half reads as "that stage never ran".
- **Span attributes may carry correlation ids; metric labels may not (#535)** — a label mints a time series forever, a span attribute lives on one span. Content, phones, JIDs and free text are forbidden on both.
- **Span emission status is declared and test-enforced (#535)** — the taxonomy states which spans have emitters, so it cannot overstate coverage.

---

| | |
|---|---|
| Last verified | 2026-08-14 |
| Against `main` HEAD | `356dc2e4` + issue #535 gate 6 (review da PR #554) |
| Re-verify when | Older than 30 days; OR `audit-actions.ts` adds a variant; OR `metrics.ts` changes counter labels; OR `runtime-trace/` changes envelope/body split; OR `policy-dsl/` adds an operator |
