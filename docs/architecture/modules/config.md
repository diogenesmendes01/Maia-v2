# config

**Path:** `src/config/`

**Purpose** — Zod-validated environment configuration and feature flags. Every env var read by the app passes through `env.ts` — call sites get a typed object, not raw strings. Feature flags (`MULTI_AGENT_SELECTOR_V2`, `FEATURE_SCHEDULING_V2`, `FEATURE_PDF_REPORTS`, etc.) are surfaced via `feature-flags.ts` so toggling state at runtime is a config concern, not an `if (process.env.X === 'true')` sprinkled across modules.

## Key files

| File | Role |
|---|---|
| `src/config/env.ts` | Zod schema for env vars; produces a typed config object at startup |
| `src/config/feature-flags.ts` | Feature-flag accessors with defaults |

## Patterns it follows

- Fail-fast at startup: an invalid or missing required env var aborts the process before any tenant context is set up
- Feature flags default to **off** unless explicitly enabled (fail-closed)

## How to extend

| Need | Where |
|---|---|
| Add a new env var | Extend Zod schema in `env.ts`; update `.env.example`; reference via typed config |
| Add a new feature flag | Extend `feature-flags.ts`; default to `false`; document the gate in the relevant runbook |
| Change a flag default | Audit every reader; flip cautiously — fail-closed semantics may flip too |

## Public surface

Every module imports the typed config object (or specific keys) from `src/config/env.ts`. Direct `process.env.X` reads outside `src/config/` are anti-pattern.

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/config/` | Schema validation, default behavior, missing-var errors |

## In-flight changes

At last verification (2026-05-28): none specifically scoped to `src/config/`. Flags are introduced alongside the features that gate on them.

Verify: `gh pr list --state open --search "config OR env OR feature-flag"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
