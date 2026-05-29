# user-layer

**Path:** `src/user-layer/`

**Purpose** — The interlocutor model — what the agent knows about the person it's talking to right now, and how visible that knowledge is per interlocutor. Resolvers pull facts, hints, rules, and memories scoped to the interlocutor; visibility + depth rules decide what the agent may use vs may mention. Tenant-boundary enforcement happens here in addition to the DB layer.

## Key files

| File | Role |
|---|---|
| `src/user-layer/index.ts` | Public surface |
| `src/user-layer/types.ts` | Shared types |
| `src/user-layer/user-slice-builder.ts` | Builds the user slice for the context packet |
| `src/user-layer/knowledge-slice-builder.ts` | Knowledge slice (legacy path; main one is in `src/runtime/context-assembly/`) |
| `src/user-layer/internal/cache-keys.ts` | Cache-key construction (tenant-scoped) |
| `src/user-layer/internal/depth-mapping.ts` | Depth/visibility mapping per knowledge type |
| `src/user-layer/internal/tenant-boundary.ts` | Tenant-boundary check in user-layer code paths |
| `src/user-layer/internal/visibility.ts` | Per-fact/hint visibility rules |
| `src/user-layer/resolvers/facts-resolver.ts` | Resolves facts about interlocutor |
| `src/user-layer/resolvers/hints-resolver.ts` | Resolves hints |
| `src/user-layer/resolvers/interlocutor-resolver.ts` | Resolves the interlocutor itself |
| `src/user-layer/resolvers/memory-resolver.ts` | Resolves memories visible to this interlocutor |
| `src/user-layer/resolvers/rules-resolver.ts` | Resolves rules applying to this interlocutor |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — `tenant-boundary.ts` is the user-layer-specific check on top of DB tenant-guard
- [Cognitive stack](../concerns/cognitive-stack.md) — visibility (`mention_allowed` / `proactive_use`) controls what the agent may *say*, not just what it may *use*
- Memory uses 6 controls per entry (`memory_type / scope / sensitivity / proactive_use / mention_allowed / ttl_days`); user-layer respects them

## How to extend

| Need | Where |
|---|---|
| Add a new resolver | New file under `resolvers/`; tenant-bounded; respect visibility |
| Add a visibility dimension | Extend `internal/visibility.ts`; update `depth-mapping.ts`; ensure every resolver applies it |
| Add a new slice | Slice builder under `src/runtime/context-assembly/slice-builders/`; user-layer here only handles interlocutor-scoped slices |

## Public surface

| Consumed by | What |
|---|---|
| `src/runtime/context-assembly/slice-builders/user-slice-builder.ts` | Imports user-layer resolvers |
| `src/cognition/` | Some cognitive modules read interlocutor model |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/user-layer/` | Resolver contracts + visibility |
| `tests/unit/user-layer/tenant-boundary.spec.ts` | Tenant-boundary check |

## In-flight changes

At last verification (2026-05-28): no PR specifically scoped to `src/user-layer/`. Visibility rules iterate with the broader memory scoping work.

Verify: `gh pr list --state open --search "user-layer OR interlocutor OR visibility"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
