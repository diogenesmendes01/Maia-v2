# admin-ui

**Path:** `src/admin-ui/`

**Purpose** — Next.js 14 + tRPC + NextAuth + Drizzle governance console. The owner-facing surface where capability/skill/procedure proposals are approved, drift alerts are triaged, knowledge state transitions are reviewed, audit/trace events are explored, and per-tenant settings are managed. Runs as a separate process on port 4000.

## Key files

| Path | Role |
|---|---|
| `src/admin-ui/trpc/routers/` | 19 tRPC routers (governance surface) |
| `src/admin-ui/app/` | Next.js App Router pages (pt-BR, agent-first IA) |
| `src/admin-ui/components/ui/` | Design-system primitives (Button, Card, Field, Table, Modal, …) |
| `src/admin-ui/components/layout/` | App shell: dark sidebar + nav config (`nav.ts` is the IA source of truth) |
| `src/admin-ui/next.config.mjs` | Build configuration |

### UI architecture (2026-06 redesign)

The visual layer was rebuilt agent-first: `/agents` is the hub (cards), `/agents/new` is a 5-step wizard (função/arquétipo → identificação → personalidade → comportamento → revisão), and `/agents/[agentId]` concentrates configuration (overview / profile editor / version approval) per agent. All pages compose the primitives in `components/ui/` — no page hand-rolls form controls, tables, or modals. Legacy `/setup/agents` redirects to `/agents`.

### Configuration journey (2026-07, PRs #491–#493)

The "new agent → answers on a channel" journey closes entirely in the UI:

- **Channels + roles CRUD** (`/setup/channels`) — previously seed/SQL-only; channel policies show per-channel readiness (`policy_ready` = policy exists AND its default role is active).
- **Go-live checklist** on the agent overview: profile active → channel registered → role+policy ready, each linking to the screen that resolves it; disappears when complete.
- **Single approval surface** for operational profiles (spec perfil-inbox v4, fase C): profiles are a NATIVE source of the unified proposal engine. `/inbox` lists them with computed risk + exhaustive diff and decides via `proposals.approve`/`reject`; the agent's Versões tab calls the SAME endpoint (the version id IS the proposal id), so dual-approval (`high` risk) can collect its second signature on either surface. `/identities` is a read-only cross-agent view linking into the agent (`?tab=` deep-link). The legacy `agents.approveProfile` shim and the bespoke `agents.pendingProfileApprovals` card were removed with the `FEATURE_PROFILE_INBOX_SOURCE` flag.
- **Progressive disclosure** in the shared profile form: princípios and limites cognitivos are collapsed "avançado" cards with always-visible summaries.
- **Capabilities editing** on the agent overview: domain packs + hard denies via `agents.updateCapabilities` (owner/founder; atomic grant+audit via `agentToolGrantsRepo.updateWithAudit`; `mcp.*` packs preserved — managed in `/setup/mcp`). New-tool acquisition stays in the `capability_proposals` flow.

### tRPC routers

| Router | What it serves |
|---|---|
| `agents` | Agent provisioning, profile version proposals (create/updateProfile), capabilities (view/edit) — profile DECISIONS live in `proposals` |
| `audit` | Audit log explorer |
| `capabilities` | Capability proposals + approvals |
| `channelPolicies` | Channels + roles creation, channel policy CRUD, channels overview (policy readiness) |
| `drift` | Drift alert triage |
| `inbox` | Operator inbox (unified proposal queue) |
| `knowledge` | Knowledge state machine explorer |
| `llmSettings` | LLM model + cost configuration |
| `mcp` | MCP server registry + per-agent `mcp.*` pack grants |
| `objectives` | Agent objectives + tasks (work loop) |
| `playground` | Sandbox chat against the runtime (no side effects) |
| `procedures` | Procedure definitions + executions |
| `proposals` | Proposal detail + approve/reject (unified engine) |
| `skills` | Skill catalog + lifecycle |
| `tenants` | Tenant provisioning |
| `tools-catalog` | Tool registry view |
| `traces` | Runtime trace explorer |
| `versions` | Identity version history + rollback |
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

At last verification (2026-07-14):

- Fases 1–4 do relatório de complexidade de configuração mescladas (#491, #492, #493)
- Roteamento multi-agente no gateway e perfil operacional como source do Proposal Inbox (dual-approval) IMPLEMENTADOS (#496 — fases A/B atrás de flag); a fase C (este módulo: decisão só no motor unificado, sem shim/card/flag) está no PR #499

Verify: `gh pr list --state open --search "admin-ui"`.

---

| | |
|---|---|
| Last verified | 2026-07-14 |
| Against `main` HEAD | `dc835ef` |
