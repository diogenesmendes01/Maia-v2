# config

**Path:** `src/config/`

**Purpose** — Single, typed, side-effect-free contract for every Maia environment variable, plus the per-service loaders that turn an environment snapshot into a typed configuration object. Since issue #515 the contract is the source of truth for the runtime schema, the Admin UI, the migration runner, the backup tooling, `.env.example`, the configuration documentation, the per-service manifest and the CI drift check — call sites get a typed object, never raw strings.

## Key files

| File | Role |
|---|---|
| `src/config/contract.ts` | **Canonical table** of every variable (schema + metadata) and of the tombstones. Imports only `zod`. |
| `src/config/metadata.ts` | Types and shared vocabulary: profiles, services, groups, `EnvVarSpec`, `Tombstone`, `ConfigProblem`, Maia namespaces, placeholder detection |
| `src/config/profiles.ts` | `MAIA_ENV` resolution, `NODE_ENV` contradiction check, strict-profile predicate |
| `src/config/rules.ts` | Cross-field rules, tagged `boot` (enforced by the loader, messages frozen) or `contract` (enforced by `maia config check`) |
| `src/config/validate.ts` | `validateConfig()` — pure, reports every problem in one run, redacts by construction |
| `src/config/redact.ts` | Secret redaction (`scrubSecrets`, `redactEnv`) |
| `src/config/services.ts` | Minimum configuration per service; `manifestForService`, `assertServiceMayRead` |
| `src/config/load.ts` | `loadServiceConfig()` + `ConfigValidationError` + `bootSummary()` |
| `src/config/migration-config.ts` · `admin-config.ts` · `backup-config.ts` | Named loaders for the migration runner (#516), the Admin UI and backup/restore |
| `src/config/generate.ts` | Deterministic generators for every artifact |
| `src/config/env-file.ts` | `parseEnvFile()` — delegates to `dotenv.parse`, the same parser the boot uses, so CLI and runtime cannot disagree about a `.env` line |
| `src/config/env.ts` | **Thin** boot loader: `dotenv/config` + the runtime schema from the contract; exports the `config` singleton |
| `src/config/feature-flags.ts` | Runtime feature-flag overrides / kill switches on top of the env defaults |
| `src/config/generated/` | Generated artifacts (JSON Schema, service manifest, per-profile fixtures) |

## Patterns it follows

- **The contract has no import-time side effects.** No `dotenv`, no `process.env`, no filesystem, no network, no singletons. This is what lets `maia doctor` (#517), the migration runner (#516), the CLI and the test suite reason about configuration without booting the world. Enforced by `tests/unit/config/contract-purity.spec.ts`, which walks the real import graph.
- **Fail-closed at boot, in EVERY profile.** An invalid or missing required variable, an unknown Maia variable, a tombstoned one, or a `NODE_ENV` × `MAIA_ENV` contradiction aborts before any tenant context is set up — in `development` exactly as in production. This is a **deliberate owner decision** taken during PR #522 review, diverging from step 6 of the #515 rollout (which specified a warning in development); do not "fix" it as a bug. Never a silent default, never the `'default'` literal. The escape hatch is `MAIA_CONFIG_STRICT_BOOT=false` (env-only, no redeploy, loud warning on every start) — see [`docs/runbooks/config-contract.md`](../../runbooks/config-contract.md).
- **Rejection rules must be EXACT, not heuristic.** With a fail-closed boot, a false positive is a production outage. `secret/synthetic-fixture` matches a secret's fixture value by exact equality per variable — an earlier regex over any value containing `fixture` would have aborted a legitimate `OWNER_NOME=Fixture Labs`. Checklist in [`docs/runbooks/config-contract.md`](../../runbooks/config-contract.md) §5.
- **Profiles are explicit.** `MAIA_ENV` (`development` | `staging` | `production`) decides which rules are mandatory; `NODE_ENV` keeps controlling Node platform optimisations only, and a contradiction between the two is an error.
- **Secrets never appear in output.** Messages name the variable and the rule, never the value — canary-tested in `tests/unit/config/validate.spec.ts`.
- **Generated, not hand-edited.** `.env.example`, `docs/configuration.md`, the JSON Schema, the service manifest and the fixtures come from `npm run config:generate`; CI fails on drift.
- Feature flags default to **off** unless explicitly enabled (fail-closed).

## How to extend

| Need | Where |
|---|---|
| Add a new env var | Add the entry to `ENV_CONTRACT` in `contract.ts`, run `npm run config:generate`, commit the artifacts |
| Make a variable required only under a condition | `requiredWhen` on the entry — an **executable** `RequiredWhen` condition (`equals` / `includes` / `truthy` / `present` / `anyOf` / `allOf`), never prose. The validator evaluates it (`contract/required-when`) and the docs sentence is derived from it |
| Add another cross-field requirement | `rules.ts`, scope `contract` (scope `boot` only when the loader itself must refuse to start) |
| Deprecate a var | Set `deprecatedSince` + `replacement`; the validator emits `contract/deprecated` |
| Remove a var | Delete the entry **and** add a `Tombstone` — never a silent removal, never a rename |
| Add a new feature flag | Contract entry in the `feature-flags` group, default `false`; extend `feature-flags.ts`; document the gate in the relevant runbook |
| Give a service access to a var | Add the service to the entry's `services` list |
| Read config in a new module | Import the service loader (or the `config` singleton). **Never** `process.env` — `eslint.config.js` fails the build |

The full runbook (add / deprecate / remove) is generated into [`docs/configuration.md`](../../configuration.md).

## Public surface

```ts
// Pure contract — safe anywhere
import { ENV_CONTRACT, CONTRACT_VERSION, objectSchemaForService, entriesForService } from '@/config/contract.js';
import { validateConfig, formatHuman, formatJson } from '@/config/validate.js';
import { resolveProfile } from '@/config/profiles.js';
import { manifestForService, assertServiceMayRead } from '@/config/services.js';

// Loaders — read the environment at CALL time
import { loadServiceConfig, ConfigValidationError, bootSummary } from '@/config/load.js';
import { loadMigrationConfig } from '@/config/migration-config.js';

// Runtime singleton (has import-time side effects, by design)
import { config } from '@/config/env.js';
```

Direct `process.env.X` reads outside `src/config/` are an anti-pattern, enforced by the `no-restricted-properties` rule in `eslint.config.js` with an explicit, shrinking allow-list.

## Commands

```bash
npm run config:generate       # regenerate every artifact
npm run config:check:drift    # CI gate: fail if an artifact is stale
npm run config:check -- --profile production --env-file .env [--json]
npm run config:init -- --profile production   # operational template
```

**Templates vs. fixtures — they are not interchangeable.**
`config:init` writes an *operational template*: every value the operator owns is
`__SET_ME__`, so `config:check` **fails on purpose** until it is filled in. The
files in `src/config/generated/fixtures/` are the opposite — a synthetic witness
that the contract is satisfiable, with predictable values that authenticate
against nothing. `config:check` rejects those outside development
(`secret/synthetic-fixture`); only `--allow-fixtures`, used to validate the
fixture files themselves, accepts them. `--allow-placeholders` (used for
`.env.example`) does **not** imply `--allow-fixtures`, and vice versa.

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/config/contract.spec.ts` | Contract shape, tombstones, per-service subsets, no regression on the legacy runtime keys |
| `tests/unit/config/contract-purity.spec.ts` | Import-graph purity; `contract.ts` imports only `zod`; generator determinism |
| `tests/unit/config/validate.spec.ts` | Per-profile table tests, cross-field rules, unknown/deprecated/removed, secret canary |
| `tests/unit/config/loaders.spec.ts` | Per-service loaders, `ConfigValidationError`, manifests |
| `tests/unit/config/generated-artifacts.spec.ts` | Golden tests for every generated artifact |
| `tests/unit/config/parity.spec.ts` | Compose/Dockerfile ↔ contract parity; Node/npm version parity |
| `tests/unit/config/no-direct-env-reads.spec.ts` | The `process.env` allow-list is exact and the ESLint rule is live |
| `tests/unit/config/env-file.spec.ts` | `parseEnvFile` ↔ `dotenv.parse` parity (inline comments, quoting, escapes, multi-line) |
| `tests/unit/config/required-when.spec.ts` | Every `requiredWhen` in the contract, both branches; the case list is asserted to equal the contract's |
| `tests/unit/config/init-template.spec.ts` | `config init` emits a template (never a fixture), it fails until filled and passes once filled; fixture-as-environment is rejected |
| `tests/unit/config/boot-fail-closed.spec.ts` | The real loader aborts on tombstone / unknown key / profile contradiction in every profile, and the `MAIA_CONFIG_STRICT_BOOT=false` rollback behaves as documented |

## In-flight changes

Issue #515 landed the contract, the generators, the validation and the fail-closed boot (rollout step 8, brought forward by the owner during PR #522 review). Still open, by design:

- migrating the remaining direct `process.env` readers listed in the ESLint allow-list;
- `maia doctor` (#517) and the migration runner (#516) consuming the loaders;
- boot observability (emit profile / contract version / config hash / warning count as a metric — `bootSummary()` already produces the payload, nothing publishes it yet).

Verify: `gh pr list --state open --search "config OR env OR feature-flag"`.

---

| | |
|---|---|
| Last verified | 2026-07-28 |
| Against `main` HEAD | `d93624b` |
