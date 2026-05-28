# governance

**Path:** `src/governance/`

**Purpose** — Audit writer, rule engine, dual-approval state machine, idempotency cache, lockdown gate, permissions matrix, and the policy DSL. Governance is the precondition under which any side-effect is allowed. `audit()` is the single audit entry point (with synthetic `system` fallback for tenant-less paths). `idempotency` deduplicates side-effecting tool calls. `lockdown` is the system-wide pause gate. `policy-dsl/` lets owners express rules declaratively.

## Key files

| File | Role |
|---|---|
| `src/governance/audit.ts` | `audit()` — single writer; injects ALS context, synthetic `system` fallback, emits counter |
| `src/governance/audit-actions.ts` | Typed enum of audit actions |
| `src/governance/audit-mode.ts` | Live / silent / test modes |
| `src/governance/rules.ts` | Rule engine over typed intents |
| `src/governance/dual-approval.ts` | Dual-approval state machine for irreversible actions |
| `src/governance/idempotency.ts` | Idempotency cache (per-tenant + key) |
| `src/governance/lockdown.ts` | System-wide lockdown gate |
| `src/governance/permissions.ts` | Permissions matrix (pessoa × entidade × profile) |
| `src/governance/policy-dsl/index.ts` | DSL surface |
| `src/governance/policy-dsl/validator.ts` | Schema validation |
| `src/governance/policy-dsl/evaluator.ts` | Evaluator |
| `src/governance/policy-dsl/enforcement.ts` | Enforcement of evaluator verdict |
| `src/governance/policy-dsl/field-path.ts` | Field-path expression resolver |
| `src/governance/policy-dsl/regex-cache.ts` | Compiled regex cache |
| `src/governance/policy-dsl/types.ts` | Shared DSL types |
| `src/governance/policy-dsl/constants.ts` | DSL constants |

## Patterns it follows

- [Governance + observability](../concerns/governance-observability.md) — single audit entry, typed taxonomy, per-tenant metric labels
- [Tenant isolation](../concerns/tenant-isolation.md) — every governance row scopes by `tenant_id + agent_id`

## How to extend

| Need | Where |
|---|---|
| Add a new audit action | Extend `audit-actions.ts` enum; emit via `audit()`; update dashboards |
| Add a new rule | Extend `rules.ts`; rules are typed; never check raw strings |
| Add a new dual-approval flow | Extend `dual-approval.ts`; persist state in `workflows` schema |
| Add a new DSL operator | Extend `policy-dsl/evaluator.ts` + `policy-dsl/types.ts`; add validator coverage |
| Trigger lockdown | Invoke `lockdown.engage()`; lockdown is the only emergency gate — never bypass |

## Public surface

| Consumed by | What |
|---|---|
| All `src/*/` modules | Import `audit()` for any side-effect or decision |
| `src/runtime/decision/` | PEPs use `rules.ts` + `policy-dsl/` |
| `src/tools/` | Tools use `idempotency.ts` |
| `src/workflows/dual-approval.ts` | Dual-approval state |
| `src/admin-ui/` | Owner-facing surface reads governance state |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/audit-rate-limit-tenant-labels.spec.ts` | Counter labels carry tenant |
| `tests/unit/audit-tenant-fallback.spec.ts` | Synthetic `system` fallback |
| `tests/unit/governance/idempotency.spec.ts` | Idempotency cache scope |
| `tests/unit/governance/policy-dsl/` | DSL evaluator + enforcement |
| `tests/unit/constitutional.spec.ts` | Constitutional rules |

## In-flight changes

At last verification (2026-05-28):

- Governance idempotency cache scope by `tenant_id+agent_id` (#261 → #273 — open)
- Outbound idempotency ledger to close double-send window (#227 → #233 — merged; #238 — open)
- Metrics: rate-limit counter tenant_id+agent_id labels (#271 → #275 — merged)

Verify: `gh pr list --state open --search "governance OR audit OR idempotency OR dual-approval"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
