# identity

**Path:** `src/identity/`

**Purpose** — Resolves channel-side handles (e.g., WhatsApp JID) to a `pessoa_id`, manages quarantine for new/unknown identities, adjusts voice/tone per resolved interlocutor, generates identity proposals (e.g., role membership) for owner approval, and renders the operational profile slice for the context packet. Identity is the bridge between the channel layer (handle) and the cognitive layer (interlocutor model).

## Key files

| File | Role |
|---|---|
| `src/identity/resolver.ts` | Resolves channel-side handle → `pessoa_id` |
| `src/identity/duplicate-detection.ts` | Detects duplicate identities at resolution time |
| `src/identity/quarantine.ts` | Quarantines new/unknown identities until governance approves |
| `src/identity/quarantine-utils.ts` | Helpers for quarantine flow |
| `src/identity/learned-voice-modifier.ts` | Adjusts voice/tone per resolved interlocutor |
| `src/identity/profile-renderer.ts` | Renders operational profile slice for context packet |
| `src/identity/profile-legacy-resolver.ts` | Legacy profile resolution path (back-compat) |
| `src/identity/proposal-generator.ts` | Generates identity proposals for owner approval |

## Patterns it follows

- [Channel/role/policy](../concerns/channel-policy.md) — identity resolution happens after channel resolution, before cognitive turn
- [Cognitive stack](../concerns/cognitive-stack.md) — voice modifier is a cognitive artifact (deterministic, evidence-driven)
- [Governance + observability](../concerns/governance-observability.md) — quarantine + proposal flow is owner-gated

## How to extend

| Need | Where |
|---|---|
| Add a new resolution strategy | New file under `src/identity/`; dispatch from `resolver.ts` |
| Add a new quarantine rule | Extend `quarantine.ts`; persist state alongside `pessoas` row |
| Add a voice modifier dimension | Extend `learned-voice-modifier.ts`; new evidence type, deterministic formula |
| Add an identity proposal type | Extend `proposal-generator.ts`; admin-ui consumes via `proposals` router |

## Public surface

| Consumed by | What |
|---|---|
| `src/agent/core.ts` | Resolves identity at the start of every turn |
| `src/runtime/context-assembly/slice-builders/identity-slice-builder.ts` | Reads profile-renderer output |
| `src/admin-ui/` | Proposal generator outputs to `proposals` router |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/identity/resolver.spec.ts` | Resolution contract |
| `tests/unit/identity/duplicate-detection.spec.ts` | Duplicate detection |
| `tests/unit/identity/quarantine.spec.ts` | Quarantine state |
| `tests/unit/identity/voice-modifier.spec.ts` | Voice deterministic adjustments |

## In-flight changes

At last verification (2026-05-28): no PR specifically scoped to `src/identity/`. Quarantine flow is iterated alongside admin-ui proposals work.

Verify: `gh pr list --state open --search "identity OR quarantine OR voice"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
