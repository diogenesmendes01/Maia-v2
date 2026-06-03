# tools

**Path:** `src/tools/`

**Purpose** — The registry of typed, LLM-callable functions. Each tool exports a Zod input schema, an `execute(args, ctx)` function, and an idempotency-key contract. The `_registry.ts` aggregator is the single source of truth for what the LLM can invoke; `_dispatcher.ts` routes a typed intent to its handler. Tools that touch external services (vision, audio, files) cache via `_vision-cache.ts` or service-specific caches scoped by tenant.

## Key files

| File | Role |
|---|---|
| `src/tools/_registry.ts` | Aggregated tool registry — every callable surface |
| `src/tools/_dispatcher.ts` | Routes typed intent → tool handler |
| `src/tools/_vision-cache.ts` | Per-tenant vision-result cache |

### Tool categories (representative files)

| Category | Examples |
|---|---|
| Transactions | `register-transaction.ts`, `cancel-transaction.ts`, `classify-transaction.ts`, `list-transactions.ts`, `query-balance.ts` |
| Reports | `generate-report.ts`, `compare-entities.ts`, `describe-schema.ts` |
| Memory | `propose-fact.ts`, `propose-rule.ts`, `propose-hint.ts`, `propose-memory.ts`, `save-fact.ts`, `save-rule.ts`, `recall-memory.ts` |
| Pending | `ask-pending-question.ts`, `list-pending.ts` |
| Proposals | `approve-capability-proposal.ts`, `reject-capability-proposal.ts`, `list-pending-proposals.ts` |
| Multimedia | `parse-image.ts`, `parse-boleto.ts`, `parse-receipt.ts`, `transcribe-audio.ts` |
| Scheduling | `schedule-reminder.ts`, `cancel-reminder.ts`, `start-recurring-payment.ts`, `start-recurring-outreach.ts` |
| Workflow | `start-workflow.ts`, `send-proactive-message.ts` |
| Identity | `identify-entity.ts` |
| Calendar | `calendar/calendar-add-business-days.ts`, `calendar/calendar-business-days-between.ts`, `calendar/calendar-is-business-day.ts`, `calendar/calendar-list-holidays.ts`, `calendar/calendar-next-holiday.ts` |
| Holidays | `register-custom-holiday.ts` |

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — every side-effecting tool carries an idempotency key
- [Tenant isolation](../concerns/tenant-isolation.md) — every tool executes within `runWithTenantContext`; caches keyed by tenant
- Zod input schema is the contract — the LLM-emitted intent is validated against it before `execute()` runs

## How to extend

| Need | Where |
|---|---|
| Add a new tool | New file `src/tools/<name>.ts` with: Zod `input` schema, `execute(args, ctx)`, `name`, `description`, optional `idempotency_key` derivation; register in `_registry.ts` |
| Add a tool category | Group under a subdir (see `calendar/`); register in `_registry.ts` |
| Add a result cache | Per-tool or per-service; key by `tenant_id + agent_id + ...` (never key by business id alone) |
| Generate the tool catalog | `npm run gen:tool-catalog` produces a serialized catalog for the admin-ui |

## The capability chain (issues #410 + #408)

The LLM-visible tool set is the product of a six-link chain. Each link is an
ADDITIVE filter applied BEFORE the existing dispatcher guards — none of them
replaces a guard (invariant #2: LLM proposes, backend disposes).

```
Tool Catalog → Tool Pack → Agent Tool Grants → Skill Tool Scope
             → Runtime Tool Filter → Dispatcher Guard
```

```
VISÍVEL = ( baseline.core ∪ granted_packs ∪ granted_tools − denied_tools )  ← the AGENT  (agent_tool_grants)
        ∩ ( skill.allowed_tools − skill.denied_tools )                      ← the SKILL  (SkillToolScope)
        ∩ ( required_actions ⊆ permissões da pessoa )                       ← the HUMAN  (getAgentToolSchemas)
        ∩ ( isToolEnabled / feature flag )                                  ← kill-switch (getAgentToolSchemas)
        ∩ ( skill permitida p/ audiência/canal/data_scope/risco )          ← #409 (audience layer; NOT wired yet)
```

…and the Dispatcher Guard revalidates the agent-grant axis server-side, so a
tool the LLM should never have seen still cannot execute (invariant #5).

### Formal contracts

| Contract | Shape | Where |
|---|---|---|
| **ToolCatalog** | the registry (`Tool<I,O>`, ~16 fields) + `buildToolCatalog()` (every tool incl. flag-gated, with its gating flag) | `src/tools/_registry.ts`; generated artifact `src/admin-ui/generated/tool-catalog.ts` |
| **ToolPack** | `{ id, name?, domain?, version, description, risk_level?, default_for_agent_type?, tools }` — a PRODUCT definition (code), never per-tenant data | `src/tools/grant-math.ts` (definitions), re-exported by `src/tools/packs.ts` (registry-validated) |
| **AgentToolGrant** | `{ tenant_id, agent_id, granted_packs, granted_tools, denied_tools, granted_by, reason, created_at, updated_at }` — per-agent DATA | table `agent_tool_grants` (migration `076`), repo `agentToolGrantsRepo` (`src/db/repositories.ts`), runtime type in `grant-math.ts` |
| **SkillToolScope** | `{ skill_id?, allowed_tools?, denied_tools?, requires_confirmation_for? }` — extends `skill.allowed_tools` | `src/tools/grant-math.ts` (`resolveSkillToolScope`); consumed in `src/skills/modes/tool-mediated.ts` + the decision packet's `tool_permissions` |
| **RuntimeToolFilter** | `computeAgentVisibleTools(grant, skillScope)` (agent ∩ skill, pure) + `computeRuntimeVisibleTools(...)` (adds human-permission/flag via `getAgentToolSchemas` + audits provenance) | `src/tools/grant-math.ts` + `src/tools/runtime-filter.ts`; called from `src/agent/core.ts` |
| **DispatcherGuard** | the existing 12+ guards PLUS the new `tool_not_granted` guard (refuses a tool outside the effective agent grant, BEFORE the `canAct`/permission guard) | `src/tools/_dispatcher.ts` |

### Packs

- `baseline.core` (`risk_level` low) — the conservative floor every agent has
  (#410). ALWAYS unioned into the effective grant, even when the persisted row
  omits it, so a malformed/missing grant degrades to the floor, never to zero.
- `domain.finance` (high), `domain.sales` (medium), `domain.support` (low),
  `domain.calendar` (medium), `domain.operations` (medium) — the #408 verticals.
  Domain packs are NEVER in `DEFAULT_AGENT_PACKS`; they are granted explicitly.

### Defaults & isolation

- Every agent gets a `['baseline.core']` grant at creation
  (`agentsRepo.createWithSeedAndAudit`, in the SAME tx as the agent + seed
  profile) and via the idempotent backfill in migration `076`.
- `agent_tool_grants` carries `tenant_id + agent_id` (invariant #1), UNIQUE per
  `(tenant_id, agent_id)`. Every repo read/write is ALS-scoped. Isolation is
  proven DB-free in `tests/unit/agent-tool-grants-repo-scope.spec.ts` and against
  a real DB in `tests/integration/agent-tool-grants-leak.spec.ts`.

### `denied_tools` is HARD

A `denied_tools` entry (on the grant OR the skill scope) is removed from the
visible set AND refused by the dispatcher, even if it is also in a granted pack.

### Provenance audit

`computeRuntimeVisibleTools` emits one `tool_visibility_resolved` audit row per
turn recording which packs/granted-tools/denies/skill produced the visible set.
A dispatcher refusal of an un-granted tool emits `tool_not_granted` (distinct
from the human-permission `unauthorized_access_attempt`).

### #409 hook (NOT done here)

The audience/data_scope/risk layer narrows the `SkillToolScope` and/or
post-filters the visible set AFTER `computeAgentVisibleTools`. Its inputs are the
pack `risk_level` and the resolved `AudienceContext` (#407). `DataScope` in
`src/shared/audience.ts` is still unclaimed.

## Public surface

| Consumed by | What |
|---|---|
| `src/skills/modes/tool-mediated.ts` | Skills invoke tools through the registry; enforces `SkillToolScope` |
| `src/agent/core.ts` | ReAct loop dispatches tool intents; runs the Runtime Tool Filter |
| `src/admin-ui/src/server/routers/tools-catalog.ts` | Owner-facing tool catalog view |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/tools/` | Per-tool input schema + execute contract |
| `tests/integration/tools/` | Tools that touch real Postgres / Redis |

## In-flight changes

At last verification (2026-05-28):

- Vision cache include `tenant_id` in cache key (#250 → #257 — open)
- Tool-mediated skill fail-closed on missing tenant context (#262 → #269 — open)

Verify: `gh pr list --state open --search "tools OR tool-mediated OR _registry"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
