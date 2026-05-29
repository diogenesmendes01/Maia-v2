# workflows

**Path:** `src/workflows/`

**Purpose** — Multi-turn / multi-party state machines that span individual turns. Two main flows: pending questions (agent asks user something, holds outbound until answered) and dual-approval (irreversible actions require two approvers). Both have persistent state in Postgres + a state machine in code. Procedures (`src/procedures/`) are a different beast — single-agent multi-step; workflows are multi-actor/multi-turn.

## Key files

| File | Role |
|---|---|
| `src/workflows/engine.ts` | Workflow engine — drives transitions |
| `src/workflows/pending-questions.ts` | Pending-question state machine (`applyResolution`, `IntentResolution`) |
| `src/workflows/dual-approval.ts` | Dual-approval state machine |
| `src/workflows/types.ts` | Shared types |

## Patterns it follows

- [Governance + observability](../concerns/governance-observability.md) — dual-approval is the standard gate for irreversible actions; every transition audits
- [Action layer](../concerns/action-layer.md) — workflow-selector in decision-engine routes to a workflow when applicable
- [Tenant isolation](../concerns/tenant-isolation.md) — persistent state scoped by `tenant_id + agent_id`

## How to extend

| Need | Where |
|---|---|
| Add a new workflow | New file `src/workflows/<name>.ts`; persist state in dedicated table; selector wired in `src/runtime/decision/workflow-selector.ts` |
| Add a transition to dual-approval | Extend `dual-approval.ts`; document new audit action label |
| Add a pending-question type | Extend `pending-questions.ts:applyResolution`; resolver in `src/agent/pending-resolver.ts` |
| Expire / remind | Workers `pending-expirer.ts` and `pending-reminder.ts` already cover the lifecycle |

## Public surface

| Consumed by | What |
|---|---|
| `src/runtime/decision/workflow-selector.ts` | Routes turns to workflows |
| `src/agent/pending-gate.ts` | Gates execution while pending exists |
| `src/agent/pending-resolver.ts` | Resolves user input against pending |
| `src/tools/start-workflow.ts` | LLM-callable workflow launcher |
| `src/tools/ask-pending-question.ts` | LLM-callable pending creation |
| `src/workers/pending-expirer.ts`, `src/workers/pending-reminder.ts` | Pending lifecycle |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/workflows/pending-questions.spec.ts` | Pending state machine |
| `tests/unit/workflows/dual-approval.spec.ts` | Dual-approval transitions |
| `tests/integration/workflows/` | End-to-end |

## In-flight changes

At last verification (2026-05-28): no PR specifically scoped to `src/workflows/`. Pending-question lifecycle is iterated alongside agent + admin-ui work.

Verify: `gh pr list --state open --search "workflow OR pending OR dual-approval"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
