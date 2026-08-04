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
the two drift. Today `turn`, `queue.wait` and `tool.dispatch` are emitted; the
other 20 are declared.

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
| `tests/unit/observability/otlp-exporter.spec.ts` | OTLP wire contract + bounded/counted loss |
| `tests/unit/observability/runtime-collectors.spec.ts` | pool/session/scheduler gauges render NaN, never a healthy 0 |
| `tests/unit/observability/instrumentation.spec.ts` | Returned `{error}` is classified, not counted as success |
| `tests/unit/observability/dashboards.spec.ts` | Dashboards ↔ emitted metrics / recording rules drift guard |
| `tests/unit/observability/overhead-benchmark.spec.ts` | Per-emission cost + cardinality budget actually bounds series |
| `tests/admin-ui/unit/traces-router.spec.ts` | Trace Explorer tenant scoping + NOT_FOUND (not FORBIDDEN) |
| `tests/integration/observability-hot-path-trace.spec.ts` | Hot-path trace through the real HMAC/redaction writers |

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

- **Span emission is partial.** `turn`, `queue.wait` and `tool.dispatch` have
  emitters; the other 20 taxonomy entries are marked `declared` in
  `SPAN_EMISSION` and produce nothing. The marking is test-enforced, so this
  list cannot silently go stale.
- **`context.load` is not emitted on the hot path.** `instrumentContextLoad`
  exists and is tested, but the turn's context assembly lives in
  `src/agent/prompt-builder.ts`, which #535 did not touch. `maia_context_load_ms`
  therefore has no production series yet — one wrap away.
- **Runtime trace on the hot path is gated OFF** (`FEATURE_RUNTIME_TRACE_V1`)
  pending the canary rollout in `docs/runbooks/observability-slo.md`.
- **Not yet instrumented**: outbound send duration (`maia_outbound_send_ms`),
  ingress normalize/persist, identity/audience resolution.
- **The overhead benchmark is micro, not under load.** Real cardinality under
  production traffic is still unmeasured; the budget is proven to BOUND the
  series count, not sized against observed traffic.
- **`root_trace_id` / `attempt` are still outside `envelope_hmac`** — the
  owner decision the issue asks for has not been recorded.

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
| Last verified | 2026-08-04 |
| Against `main` HEAD | `7b34e7e` + issue #535 |
| Re-verify when | Older than 30 days; OR `audit-actions.ts` adds a variant; OR `metrics.ts` changes counter labels; OR `runtime-trace/` changes envelope/body split; OR `policy-dsl/` adds an operator |
