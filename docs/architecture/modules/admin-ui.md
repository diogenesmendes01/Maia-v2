# admin-ui

**Path:** `src/admin-ui/`

**Purpose** — Next.js 14 + tRPC + NextAuth + Drizzle governance console. The owner-facing surface where capability/skill/procedure proposals are approved, drift alerts are triaged, knowledge state transitions are reviewed, audit/trace events are explored, and per-tenant settings are managed. Runs as a separate process on port 4000.

## Key files

| Path | Role |
|---|---|
| `src/admin-ui/src/server/routers/` | 16 tRPC routers (governance surface) |
| `src/admin-ui/src/pages/` or `app/` | Next.js routes |
| `src/admin-ui/next.config.js` | Build configuration |

### tRPC routers

| Router | What it serves |
|---|---|
| `agents` | Agent provisioning + listing |
| `audit` | Audit log explorer |
| `capabilities` | Capability proposals + approvals |
| `channelPolicies` | Channel policy CRUD |
| `drift` | Drift alert triage |
| `inbox` | Operator inbox |
| `knowledge` | Knowledge state machine explorer |
| `llmSettings` | LLM model + cost configuration |
| `procedures` | Procedure definitions + executions |
| `proposals` | Proposal aggregation across types |
| `skills` | Skill catalog + lifecycle |
| `tenants` | Tenant provisioning |
| `tools-catalog` | Tool registry view |
| `traces` | Runtime trace explorer |
| `versions` | Identity version history |
| `dashboard` | KPI summary |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — every router scopes queries by `tenant_id + agent_id`
- [Governance + observability](../concerns/governance-observability.md) — admin-ui is the human gate for proposals, drift, KSM transitions

## How to extend

| Need | Where |
|---|---|
| Add a new admin view | New tRPC router in `src/admin-ui/src/server/routers/` + matching Next.js page |
| Surface a new proposal type | Extend `proposals` router; UI lives next to `capabilities` / `skills` patterns |
| Add a new metric to dashboard | Extend `dashboard` router; add tile to dashboard page |

## Public surface

The admin-ui consumes the main app's DB schema + repositories directly (shared `drizzle` schema). It does not import from `src/agent/`, `src/cognition/`, or `src/cognitive-graph/` — runtime concerns stay in the main process.

## Tests

| Test path | What it covers |
|---|---|
| `tests/admin-ui/unit/` | Router unit tests |
| `tests/admin-ui/e2e/` | Playwright end-to-end |
| `npm run admin:acceptance` | Acceptance gates script |

## In-flight changes

At last verification (2026-05-28):

- Skills mutations + editor in admin-ui Phase 3 (#213 — merged); related lifecycle / TOCTOU fixes follow-up

Verify: `gh pr list --state open --search "admin-ui OR skills"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
