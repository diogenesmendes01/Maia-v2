# Tenant Isolation

> The platform's most important invariant. Every other invariant assumes this one holds.

## 1. The invariant

**No code path may read, write, or recall data belonging to one `(tenant_id, agent_id)` pair while serving a request scoped to another.** This holds across every stateful boundary: Postgres tables, Redis keys, in-memory caches, vector embeddings, message queues, audit rows, metric labels, ALS context, dedup keys, debounce windows, rate-limit counters, and idempotency ledgers.

Single-tenant runtime today (`tenant_id='default'`, `agent_id='default'` seeded by migration P0) does not relax the invariant — it makes it *latent*. Provisioning a second tenant must be a configuration change, never a code change.

### 1.1 The one bounded exception: `system` operational state

The invariant governs **data**. It does not govern the health of a shared external dependency, which belongs to nobody. That category — `system` operational state — is the single sanctioned exception, defined in [ADR 0002](../decisions/0002-external-dependency-health-is-system-state.md).

It is narrow on purpose. State qualifies only when **all four** hold:

1. it is not derived from tenant data;
2. the thing it measures is genuinely shared — every tenant reaches the same instance, with the same credentials, endpoint and quota;
3. only failures attributable to the dependency feed it, so no caller can move it with input it controls;
4. every individual decision made from it is still attributed with `tenant_id + agent_id`.

Conditions 3 and 4 are what make a global aggregate legitimate instead of merely convenient: no tenant can *cause* another's outcome, and every outcome remains traceable to who received it.

**Current members of this category — the complete list:**

| State | Where | Why it qualifies |
|---|---|---|
| LLM circuit-breaker state per `(provider, workload)` | `src/lib/llm/circuit-breaker.ts` | Health of a third-party API shared by all tenants. Only `provider_5xx`/`network`/`timeout` feed it; every refusal emits `maia_llm_requests_total{status="circuit_open"}` with tenant and agent. |

Adding to this table requires an ADR entry arguing the candidate against all four conditions. A code comment is **not** sufficient to except this invariant — if the only justification lives next to the code, a reviewer reading this document is right to treat the divergence as a bug.

**This exception is not a fairness mechanism.** If one tenant's traffic degrades another's while the dependency is healthy, that is noisy-neighbour, and the answer is a per-tenant bulkhead or rate limit — never fragmenting a shared-health control, which would break condition 2 and destroy its sample.

## 2. Why it matters

The platform's value proposition is *"agents learn from experience, but only evolve inside governance, scope, and evidence"* — and scope is enforced here. A single cross-tenant leak invalidates the entire learning system: a fact learned about tenant A could be recalled while answering tenant B, and the agent has no way to detect the contamination. Governance audits can't catch what isolation didn't separate in the first place.

A leak is also the worst class of bug to repair: by the time it's noticed, the contaminated memory has been used to make decisions for other tenants. There is no `DELETE WHERE leaked = true`.

## 3. Where it lives in code

### ALS context (the propagation mechanism)

| File | Role |
|---|---|
| `src/db/tenant-context.ts` | `runWithTenantContext(ctx, fn)` enters AsyncLocalStorage; `tryGetCurrentContext()` reads it without throwing; `getCurrentContext()` throws `MissingTenantContextError` if unset |
| `src/db/repositories.ts` | `applyTenantGuard()` — query-builder helper that injects `tenant_id + agent_id` predicates |

Every request entry-point (`src/gateway/baileys.ts`, every worker in `src/workers/`, every script in `scripts/`) wraps work in `runWithTenantContext` before touching state.

### Stateful boundaries and their scoping mechanism

| Boundary | Scoping mechanism | Key files |
|---|---|---|
| Postgres queries | `tenant_id + agent_id` columns + `applyTenantGuard()` | `src/db/repositories.ts`, all `*-repo.ts` |
| Vector embeddings | `agent_memories.tenant_id + agent_id` columns; recall filtered | `src/memory/vector.ts` |
| Working memory (Redis) | Key prefix `tenant_id:agent_id:...` | `src/memory/working.ts` |
| Procedural memory | `rulesRepo` mutations scoped | `src/memory/procedural.ts` |
| Knowledge state machine | `learned_rules.tenant_id + agent_id`, transition methods scoped | `src/control-plane/knowledge-state-machine/repos.ts` |
| Rate-limit (Redis) | Key prefix includes tenant | `src/gateway/rate-limit.ts` |
| Dedup (Redis) | Key includes tenant | `src/gateway/dedup.ts` |
| Debouncer (Redis) | Phone-keyed with tenant prefix | `src/gateway/debouncer.ts` |
| Bot-detection (Redis) | Key prefix with tenant | `src/gateway/bot-detection.ts` |
| Idempotency cache | `tenant_id + agent_id` in cache key | `src/governance/idempotency.ts` |
| Knowledge-slice cache | `agent_id` in cache key | `src/runtime/context-packet/cache/slice-cache.ts` |
| Vision cache | `tenant_id` in cache key | `src/tools/parse-image.ts`, `src/tools/parse-receipt.ts` |
| Holidays cache | `tenant_id + agent_id` in cache key | `src/lib/holidays.ts` |
| Audit log | `audit_logs.tenant_id + agent_id` + metric labels | `src/governance/audit.ts` (see §4) |
| Outbox | `outbox.tenant_id + agent_id` | `src/scheduling/repos.ts` |
| Policy pubsub | Per-tenant Redis channel | `src/control-plane/policy/policy-cache.ts` |

## 4. Patterns

### 4.1 Enter context at the boundary, never thread it through arguments

`runWithTenantContext({ tenant_id, agent_id }, async () => { ... })` at the top of every request handler, worker iteration, and script entry. Downstream code reads via `tryGetCurrentContext()` or `getCurrentContext()` — the ALS does the propagation.

This pattern keeps function signatures clean (no `(tenant_id, agent_id, ...realArgs)` everywhere) while making the context impossible to lose silently — `getCurrentContext()` throws if called outside ALS.

### 4.1.1 Sanctioned cross-tenant readers at entry points (and their price)

An entry point that *discovers* which tenant owns the work cannot already be
scoped by that tenant. Three readers bypass `applyTenantGuard` for exactly that
reason, and they are the complete list:

| Reader | Entry point |
|---|---|
| `channelsRepo.findByExternalCrossTenant` | Baileys ingress — resolves the channel that owns an inbound JID |
| `mensagensRepo.findOwnerByIdCrossTenant` / `adoptToResolvedTenantCrossTenant` / `findByWhatsappIdCrossTenant` | `agent/core.ts` adoption + `messages.update` |
| `agentTurnsRepo.findJobScopeByIdCrossTenant` | #504 — the queue consumer, translating a V2 job's `turn_id` into `(tenant_id, agent_id, representative_message_id)` |

The bypass is not what makes these safe; the predicates around them are. For the
third one — the newest — the guarantees are enumerated in
[`src/runtime/turns/scope-resolver.ts`](../../../src/runtime/turns/scope-resolver.ts)
and summarised in [`modules/runtime.md`](../modules/runtime.md): the payload
cannot carry scope (the V2 schema is `.strict()`), the projection carries no
content columns, the turn→message pointer is **reconciled** rather than trusted
(`agent_turns.representative_message_id` has no foreign key), every non-resolution
fails closed including the `default`/`system` sentinels, and every refusal is
audited (`turn_job_scope_rejected`) and metered with a closed-vocabulary reason.

Adding a fourth reader to this table is a reviewed decision with the same bar.

### 4.2 Synthetic `system` context for legitimately tenant-less paths

Some paths legitimately have no tenant: setup CSRF failures, Baileys pairing, bot-detection, startup/shutdown, worker bootstrap. The audit writer wraps these in `runWithTenantContext({ tenant_id: 'system', agent_id: 'system' }, ...)` so the row is preserved and visible to the audit watcher, distinct from the legacy `'default'` literal. See `src/governance/audit.ts:73-83`.

### 4.3 Defense-in-depth at every cache layer

Even when the DB query is already tenant-guarded, the cache key also includes tenant. This means a cache miss bug never crosses tenants; the worst case is a recompute, not a leak. The pattern of cache key construction is consistently `${tenant_id}:${agent_id}:${...rest}` across the codebase.

### 4.4 Fail-loud on missing or `'default'`-literal context in dynamic paths

The bootstrap migration seeds `tenant_id='default'`/`agent_id='default'` for the current single-tenant runtime. But dynamic resolvers (channel-resolver, context-builder defaultResolver) **reject** the `'default'` literal if it shows up at runtime — the literal should only ever be observable via direct DB read, never via context propagation. This prevents a "fallback to default" code path that would mask the bug of forgetting to set context.

Whitespace-only `tenant_id` / `agent_id` are also rejected (`src/db/tenant-context.ts` — see open PR #283 for the validation).

## 5. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| `WHERE id = ?` mutation on a per-tenant row | Bypasses tenant-guard. Use `applyTenantGuard()` or `WHERE id = ? AND tenant_id = ? AND agent_id = ?` |
| Redis key without tenant prefix | Two tenants can collide on shared keys. Always `${tenant_id}:${agent_id}:...` |
| Cache key keyed only by business id (e.g., `pessoa_id`) | If IDs are not globally unique across tenants, cache returns wrong data. |
| `tenant_id ?? 'default'` in a dynamic path | Hides missing context. Use `getCurrentContext()` (throws) or `tryGetCurrentContext()` + explicit branch. |
| In-memory `Map<userId, ...>` cache module-scoped | Module scope crosses requests/tenants. Use Redis with tenant-prefixed keys, or scope the Map by tenant key. |
| Worker iterating "all" rows without per-tenant batching | The worker must enter `runWithTenantContext` for each tenant separately so downstream calls see the right context. See `src/workers/reflection-batch.ts` for the pattern. |

## 6. Tests

| Test path | What it proves |
|---|---|
| `tests/integration/leak.spec.ts` | End-to-end cross-tenant query leak check |
| `tests/integration/repos-leak.spec.ts` | Repository-level leak check |
| `tests/integration/agent-tool-grants-leak.spec.ts` | `agent_tool_grants` scoped by (tenant, agent) |
| `tests/integration/playground-objectives-mcp-leak.spec.ts` | Tabelas 087/088/089 — playground, objetivos e MCP (issue #481) |
| `tests/integration/skip-locked-claims.spec.ts` | Claims `SKIP LOCKED` entregam cada row a um único worker (issue #481) |
| `tests/unit/cross-entity.spec.ts` | Cross-entity (within-tenant) boundary |
| `tests/unit/audit-rate-limit-tenant-labels.spec.ts` | Audit counter labels carry tenant attribution |
| `tests/unit/audit-tenant-fallback.spec.ts` | `system` fallback for out-of-context audits |
| `tests/unit/control-plane/knowledge-state-machine/ksm-rules-cross-tenant.spec.ts` | KSM transitions scoped |
| `tests/property/knowledge-state-machine.spec.ts` | Property-based KSM invariants |
| `tests/integration/p10a-knowledge-lifecycle.spec.ts` | KSM lifecycle stays scoped |
| `tests/integration/turn-job-v2-scope-real-db.spec.ts` | #504 — a fronteira do payload V2: um job apontando para um turno cuja mensagem representativa pertence a OUTRO `(tenant_id, agent_id)` é recusado (`scope_mismatch`) antes de qualquer trabalho de domínio, e a mensagem da vítima não é tocada. O caso de CONTROLE prova que o mesmo harness executa com o ponteiro íntegro |
| `tests/integration/onboarding-leak.spec.ts` | Saga de onboarding (#519): leitura, escrita, retomada, cancelamento e ativação escopadas; CHECK contra `'default'`/`'system'`. **Ainda não está no script `test:leak`** |
| `tests/unit/onboarding/readiness-facts-scope.spec.ts` | DB-free: o loader de readiness compila `tenant_id + agent_id` em cada `WHERE` |
| `tests/unit/onboarding/readiness.spec.ts` | Readiness nunca compõe profile de um agente com canal de outro (nem entre tenants) |

There is a dedicated npm script `npm run test:leak` that runs the leak suite — invoke it on any change that touches state or context.

## 7. Known gaps

Re-verify at read time — gap lists rot fast. Authoritative source: GitHub issues + open PRs.

To find current gaps:

```bash
gh issue list --label "tenant-isolation"
gh pr list --state open --search "tenant"
```

At last verification (2026-05-28), the README lists vector memory (#229) and procedural memory (#230) as gaps — both **already closed** by merged PRs #237 and #232 respectively. Working memory (Redis namespace), however, was being closed in flight; check whether #241 is still open.

## 8. In-flight changes

Defense-in-depth across stateful boundaries is the focus of most open PRs at last verification. Sample (verify with `gh pr list --state open --search "tenant"` for the current list):

- Redis-key tenant prefixes: rate-limit (#258), dedup (#253), debouncer (#259), bot-detection (#252), working-memory (#241)
- Cache-key tenant scoping: vision (#257), knowledge-slice (#242), holidays (#272), idempotency (#273)
- Embeddings: rebuild scope (#244), provider + dim validation (#295)
- Context resolvers: channel-resolver fail-loud (#277), defaultResolver fixture-only (#282), whitespace validation (#283)
- Policy pubsub per-tenant (#264)
- Tool-mediated skill fail-closed on missing context (#269)
- Reflection memory cleanup for pre-fix pollution (#276)

When this list outpaces the verification footer, replace it by re-running the search.

## 9. Key decisions

- **ALS over arg-threading** — `runWithTenantContext` propagates context via AsyncLocalStorage. Avoids polluting every function signature; makes missing context throw (via `getCurrentContext()`) rather than silently default.
- **Synthetic `system` bucket for tenant-less paths** — audit writer wraps non-tenant-attached events in a `system` context so rows are preserved and visible. Distinct from the legacy `'default'` literal. See `src/governance/audit.ts:65-83`.
- **Fail-loud on `'default'` in dynamic paths** — the literal is only valid at bootstrap; resolvers reject it. Prevents silent default-fallback bugs.
- **Cache keys include tenant even when DB query is already guarded** — defense in depth; cache misses recompute, never leak.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | Older than 30 days; OR `src/db/tenant-context.ts` changes; OR any cache/key construction in `src/gateway/`, `src/governance/`, `src/memory/`, `src/control-plane/policy/`, `src/runtime/context-packet/cache/` is modified |
