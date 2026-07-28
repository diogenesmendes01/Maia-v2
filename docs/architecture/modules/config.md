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
- **Fail-closed:** an invalid or missing required variable aborts before any tenant context is set up. Never a silent default, never the `'default'` literal.
- **Profiles are explicit.** `MAIA_ENV` (`development` | `staging` | `production`) decides which rules are mandatory; `NODE_ENV` keeps controlling Node platform optimisations only, and a contradiction between the two is an error.
- **Secrets never appear in output.** Messages name the variable and the rule, never the value — canary-tested in `tests/unit/config/validate.spec.ts`.
- **Generated, not hand-edited.** `.env.example`, `docs/configuration.md`, the JSON Schema, the service manifest and the fixtures come from `npm run config:generate`; CI fails on drift.
- Feature flags default to **off** unless explicitly enabled (fail-closed).

## How to extend

| Need | Where |
|---|---|
| Add a new env var | Add the entry to `ENV_CONTRACT` in `contract.ts`, run `npm run config:generate`, commit the artifacts |
| Add a conditional/cross-field requirement | `rules.ts`, scope `contract` (scope `boot` only when the loader itself must refuse to start) |
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
npm run config:init -- --profile development
```

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

## In-flight changes

Issue #515 landed the contract, the generators and the validation. Still open, by design (rollout steps 4–9 of the issue):

- migrating the remaining direct `process.env` readers listed in the ESLint allow-list;
- wiring `contract`-scope rules (unknown keys, tombstones, per-profile requirements) into the **boot** path — today boot enforces only the `boot`-scope rules, byte-for-byte what it enforced before, so this change cannot break a running deployment;
- `maia doctor` (#517) and the migration runner (#516) consuming the loaders.

Verify: `gh pr list --state open --search "config OR env OR feature-flag"`.

---

| | |
|---|---|
| Last verified | 2026-07-28 |
| Against `main` HEAD | `d93624b` |
