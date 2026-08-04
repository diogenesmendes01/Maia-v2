# ADR: External-dependency health is `system` operational state, not tenant state

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-04 |
| Owner | Maia maintainers |
| Related issue | #534 |
| Related PR | #541 |

## Context

`AGENTS.md` §4 rule 1 is the strictest invariant in this repository:

> **Every stateful boundary scopes by `tenant_id + agent_id`.**

It is written without exceptions, and that is deliberate — it is the rule that keeps one tenant's data, cache entries and Redis keys from reaching another. Almost every violation of it is a bug.

Issue #534 introduced a circuit breaker in front of the LLM gateway (`src/lib/llm/circuit-breaker.ts`). Its state is keyed by `(provider, workload)` **and by nothing else**: it is process-global, per replica. This is a real divergence from rule 1, and until this ADR it lived only as a comment in the implementation. A comment cannot except a rule described as inviolable — anyone reading `AGENTS.md` alone would correctly conclude the code was wrong.

The question this ADR settles is not "is the breaker convenient". It is: **what class of state is "this external dependency is unhealthy", and does rule 1 apply to it at all?**

Two facts frame it:

- The breaker holds no tenant data. It holds a count of recent failures of a shared, external, third-party service. That service is one service for everybody; there is no per-tenant Anthropic.
- Per-tenant scoping does not merely cost more. It **destroys the measurement**. A breaker needs a sample to decide, and a low-traffic tenant would never accumulate one. Every tenant would have to rediscover the outage independently, each burning its full retry-and-fallback budget against a provider that is already down — which is precisely the amplification the breaker exists to remove. It would also give the state unbounded cardinality, tenant × agent × provider × workload.

## Decision

**Health of a shared external dependency is `system` operational state. Rule 1 does not govern it.**

`system` is not a new concept invented here. The repository already reserves `tenant_id='system'` / `agent_id='system'` for ownerless work — seeded by `migrations/014_p0_seed_system_tenant.sql`, and used by `audit()` when there is no ambient tenant context. This ADR names the category that reservation already implied and states when it may be used.

State qualifies as `system` operational state, and is therefore outside rule 1, only when **all** of the following hold:

1. **It is not derived from tenant data.** No message content, no entity, no configuration belonging to a tenant contributes to it.
2. **The thing it measures is genuinely shared.** Every tenant talks to the same instance of it. If tenants can have distinct credentials, endpoints or quotas against that dependency, it is not shared and this ADR does not apply.
3. **Only failures attributable to the dependency feed it.** A caller must not be able to move the state with its own bad input. Concretely, in the breaker: `provider_5xx`, `network` and SDK `timeout` count; invalid payload, exhausted budget and cancelled turn do not.
4. **Every individual decision made from it remains attributed.** The aggregate may be global, but each consequence must carry `tenant_id + agent_id`. In the breaker, every refusal emits `maia_llm_requests_total{status="circuit_open"}` with both.

Conditions 3 and 4 are what make the global aggregate legitimate rather than merely convenient. Condition 3 means no tenant can *cause* another tenant's refusal through anything it controls. Condition 4 means that when a refusal happens, we can still say exactly who it happened to.

### Accepted consequence

The blast radius is global, and we are choosing that knowingly. The benchmark makes it concrete: with the breaker open during a total provider outage, three synthetic tenants received 67, 67 and 66 refusals respectively. **A healthy tenant is refused because the provider is down for everyone.**

That is the correct behaviour for a total outage — there is nothing to serve that tenant either. What this decision does *not* license is treating the breaker as a fairness mechanism. It is a load-shedding control for a dependency that is already failing, and nothing more.

### What this decision does not cover

**Noisy-neighbour isolation is a different problem with a different solution.** If one tenant's traffic degrades another's service while the provider is healthy, the answer is a per-tenant bulkhead or rate limit — not a fragmented circuit breaker. Splitting the breaker per tenant to solve a fairness problem would break condition 2 of this ADR *and* destroy the breaker's sample. The two controls compose; they do not substitute for one another.

### Review triggers

This decision must be revisited — not merely re-read — if any of the following becomes true:

- **Per-tenant provider credentials.** A tenant bringing its own API key means the dependency is no longer shared, and condition 2 fails.
- **Per-tenant provider endpoints or regions.** Same reason.
- **Per-tenant provider quotas enforced by the provider.** One tenant's 429s would then be attributable to that tenant, breaking condition 3.
- **Any new state proposed as `system` operational state.** Each candidate must be argued against the four conditions above in its own ADR entry; this one is not a blanket exemption.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Scope the breaker per `(tenant, agent, provider, workload)` | Literal compliance with rule 1 | Destroys the sample — low-traffic tenants never accumulate one; every tenant rediscovers the outage by burning its own retries, recreating the amplification the breaker removes; unbounded cardinality. Compliance in form, failure in substance. |
| Keep the breaker global, documented only in a code comment | No doc work | A comment cannot except a rule stated as inviolable. Anyone reading `AGENTS.md` alone concludes the code is wrong — and next time, correctly. Leaves the next divergence undisciplined. |
| **Name the category, state the conditions, record the triggers** (chosen) | Rule 1 keeps its force; the exception is bounded by four testable conditions and has explicit revisit triggers | Requires this ADR, an `AGENTS.md` amendment and a concern update to stay honest. |
| Drop the breaker | No divergence at all | Leaves the amplification: measured at 800 provider calls for 200 requests during an outage, against a provider already failing. |

## Validation

This decision is working when:

- every state claiming `system` scope can be checked against the four conditions, and fails the check if it does not qualify;
- the breaker's refusals remain attributable per tenant in metrics, even though its state is not;
- a reviewer encountering the global scope finds this ADR from `AGENTS.md` §4 rather than inferring a bug;
- noisy-neighbour problems are routed to bulkhead/rate-limit work rather than to fragmenting this control.

## Reversal Criteria

Revisit this decision if:

- any review trigger above fires;
- a tenant is shown to be able to open the breaker through input it controls (condition 3 broken — that is a bug in the attribution filter, and it invalidates the ADR until fixed);
- refusals stop being attributable per tenant (condition 4 broken);
- the `system` category starts being used to wave through state that is genuinely tenant-derived. The category exists to be narrow; if it becomes a habit, it has failed.

## References

- `src/lib/llm/circuit-breaker.ts` — the implementation and its thresholds
- `docs/architecture/concerns/tenant-isolation.md` — rule 1 and this exception
- `migrations/014_p0_seed_system_tenant.sql` — the pre-existing `system` reservation
- `scripts/llm-benchmark.ts` — the harness producing the outage and per-tenant refusal numbers cited above
- Issue #534, PR #541
