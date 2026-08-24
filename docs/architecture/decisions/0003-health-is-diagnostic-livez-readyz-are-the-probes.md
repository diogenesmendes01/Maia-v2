# ADR: `/health` is a diagnostic report, not a probe — `/livez` and `/readyz` carry the verdicts

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-24 |
| Owner | Maia maintainers |
| Related issue | [#613](https://github.com/diogenesmendes01/Maia-v2/issues/613) |
| Related PR | — |

## Context

`src/server.ts` exposes four health-shaped surfaces. Three of them are probes and
answer with an HTTP status the caller is meant to act on:

- **`/livez`** — is the process alive? No I/O at all. A liveness probe that touches a
  dependency turns a dependency outage into a restart loop (#512). This is the endpoint
  `compose.prod.yml` polls.
- **`/startupz`** — did initialization finish?
- **`/readyz`** — should the load balancer route here? Composite, **role-aware**
  (`src/runtime/lifecycle/roles.ts`), fail-closed, read-only, cached. Since #516 it is also
  where the canonical schema verdict is wired.

The fourth, **`/health`** (plus `/health/db`, `/health/redis`, `/health/whatsapp`), is the
component report for humans and dashboards. Until this ADR its handler never called
`reply.code` at all:

```ts
app.get('/health', async () => {
  const report = await checkAll();
  return { status: report.status, components: ... };  // always 200
});
```

The body could say `"status": "down"` while the status line said `200 OK`. That is not, by
itself, the defect. The defect is that **nothing in the code or on the wire said which of
the two readings was intended**: the missing `reply.code` was indistinguishable from an
oversight, and `docs/admin-ui-deploy.md` used to instruct operators to configure the `app`
health check as `GET /health` → 200. Anyone who followed that guide has a check that has
**never** failed and no way to notice, because it answers 200 exactly when it should be
raising the alarm. Issue #613: *"um endpoint que parece um probe, é documentado como probe,
e mente."*

Two constraints frame the decision.

**`checkAll()` is role-blind and flat.** It probes `db`, `redis` and `whatsapp`, and a
single `down` collapses the aggregate to `down` (`src/lib/healthcheck.ts`). It has no
notion of `MAIA_PROCESS_ROLE`, no notion of a required-vs-observed component, and no
degradation policy. `/readyz` has all three: `api`, `worker` and `scheduler` roles do not
require `whatsapp_session` at all, and even for the roles that do, a socket that is
reconnecting reports `degraded` and **stays in rotation** on purpose, because gating on
routine Baileys drops would drain the whole fleet on a WhatsApp hiccup
(`src/runtime/lifecycle/readiness.ts`).

**HTTP 200 on a report endpoint is not a claim about the system.** It is a claim about the
request: *I produced the report you asked for*. The verdict is in the body, and the body is
the whole point of the endpoint.

## Decision

**`/health` and `/health/{db,redis,whatsapp}` are DIAGNOSTIC endpoints. They answer `200`
whenever they can produce a report, including when that report says `degraded` or `down`.
They must never be used as a liveness, startup or readiness probe.**

The always-200 stops being an omission and becomes a stated contract, enforced in three
places at the real call site (`src/server.ts`):

1. the handler calls `asDiagnostic(reply)` — an explicit, named `reply.code(200)`, so the
   status is a decision someone made, not a line someone forgot;
2. every `/health*` response carries `x-maia-endpoint-kind: diagnostic`;
3. the `/health` body carries `probe: false` and a `probes` map naming the endpoints that
   *do* carry verdicts (`/livez`, `/startupz`, `/readyz`), so an operator who curls the
   wrong endpoint is told where the right one is, in the payload they are already reading.

`tests/unit/server/health-probe-contract.spec.ts` pins the split against the **real**
`buildServer()`: with every dependency down, `/health` is 200 and `/readyz` is 503, in the
same process, in the same test.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| **A — `/health` returns 503 when `unhealthy`** | Fixes the silently-green check of every operator who followed the old guide, without them doing anything. Matches the naive reading of the endpoint's name. | Promotes a **role-blind, flat, WhatsApp-inclusive** aggregate to a routing verdict. An `api`/`worker`/`scheduler` process legitimately has no WhatsApp session, so its `/health` would be `down` — permanently 503 — while `/readyz` correctly says ready. On the `all` role, every routine Baileys reconnect would flap it. Creates a **second** readiness gate with weaker semantics than `/readyz`, guaranteed to diverge from it, and legitimizes pointing probes at the endpoint we do not want probed. Trades a false-green for a false-red on a gate that sheds capacity. |
| **B — `/health` is diagnostic, always 200, and says so (chosen)** | One routing truth (`/readyz`): role-aware, fail-closed, already covered by #512/#516 tests. No new gate to drift. No fleet-wide draining risk. Ratifies the direction `docs/admin-ui-deploy.md` already took in #565 (*"Não use `/health`"*). 200 is the honest answer for "the report was produced". | The misconfigured operator's check stays green until they act on the CHANGELOG entry — the fix for a misconfigured external check is an operator action, not a behavior change here. A naive reader still sees `200` next to `"status":"down"`; mitigated by the header, the `probe:false` marker and the docs, not by the status line. |

Option A was rejected on the first cell of its Cons column. The risk the issue names —
"instances leaving rotation" — is understated for this codebase: with `checkAll()` as
written it would not be *wrongly-healthy* instances leaving, it would be *correctly-healthy*
instances leaving, on roles that never had a WhatsApp session to begin with.

The rejection is about `checkAll()`'s semantics, not about the principle. If `/health` ever
becomes role-aware and gains an explicit degradation policy, this ADR must be revisited
(see Reversal Criteria).

## Consequences

Positive:

- Exactly one endpoint decides routing (`/readyz`) and exactly one decides restarts
  (`/livez`). Neither can be silently duplicated by the report endpoint.
- The always-200 is now falsifiable: removing `asDiagnostic(reply)` from the handler, or
  making it conditional on `report.status`, turns
  `tests/unit/server/health-probe-contract.spec.ts` red.
- An operator who curls `/health` gets a pointer to the probe endpoints in the response
  itself.

Negative:

- **A health check pointed at `/health` still never fails.** This ADR does not fix that
  configuration; it documents it as wrong and announces it. Operators who configured
  Coolify / a load balancer / an uptime monitor against `/health` must re-point it —
  `/livez` for restart decisions, `/readyz` for routing decisions. See the CHANGELOG entry
  for #613.
- The `/health` response body grew two fields (`probe`, `probes`). Consumers that assert an
  exact key set will need updating; nothing in this repository does.

## Validation

- `tests/unit/server/health-probe-contract.spec.ts` — the four endpoints driven through the
  real `buildServer()`, with dependencies forced down, asserting: `/health` 200 with
  `status: 'down'`, `/livez` 200 with no I/O, `/startupz` 503 while starting, `/readyz` 503
  naming the blocking components.
- `tests/integration/lifecycle-probes.spec.ts` — unchanged expectation that `/health` is 200
  and writes no rows (#512).
- Operationally: `maia_readiness_check_total{component,result}` remains the series to alert
  on. `/health` is for a human reading a dashboard.

## Reversal Criteria

Revisit — do not merely re-read — if any of these becomes true:

- `checkAll()` becomes **role-aware** (consumes `MAIA_PROCESS_ROLE` / `roles.ts`) and gains
  an explicit required-vs-observed split and degradation policy. At that point the main
  objection to Option A disappears and a verdict-carrying `/health` becomes arguable.
- `/health` gains a consumer that needs a machine verdict and cannot use `/readyz` (for
  example, a monitoring product that can only assert on status codes). The answer then is
  still not to change `/health` — it is to give that consumer a purpose-built endpoint —
  but the trade-off should be re-argued here.
- The `whatsapp` component leaves `checkAll()`, making the aggregate a pure
  infrastructure-dependency verdict.

## References

- Issue [#613](https://github.com/diogenesmendes01/Maia-v2/issues/613) — `/health` responde 200 mesmo degradado.
- Issue #512 — the three-probe split (`/livez`, `/startupz`, `/readyz`), read-only probes, no raw driver text.
- Issue #516 — the canonical schema verdict wired into `/readyz`.
- Issue #565 / PR #603 — `docs/admin-ui-deploy.md` reconciliation that first flagged the misconfiguration.
- `src/server.ts` — the four handlers and `asDiagnostic()`.
- `src/lib/healthcheck.ts` — `checkAll()`, `toPublicHealthReport()`, the diagnostic constants.
- `src/runtime/lifecycle/readiness.ts`, `src/runtime/lifecycle/roles.ts` — the role-aware readiness gate.
- [`docs/runbooks/operational.md`](../../runbooks/operational.md) §8 — the probe table.
