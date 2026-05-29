# memory

**Path:** `src/memory/`

**Purpose** — Five memory layers as **thin façades** over Postgres + pgvector and Redis. Working (Redis-backed, per-conversation), episodic (turn-by-turn history in Postgres), semantic (typed facts in Postgres), procedural (rules / behavior in Postgres), vector (embeddings in pgvector). Eviction, TTL, and ranking are delegated to the underlying store — the façades are not full ORMs. Every recall and write scopes by `tenant_id + agent_id`.

## Key files

| File | Role |
|---|---|
| `src/memory/working.ts` | Redis-backed per-conversation state (turn buffer, scratch space) |
| `src/memory/episodic.ts` | Turn-by-turn history in `agent_episodes` (Postgres) |
| `src/memory/semantic.ts` | Typed facts in `agent_facts` (Postgres) |
| `src/memory/procedural.ts` | Rules + behaviors in `agent_rules` (Postgres) |
| `src/memory/vector.ts` | Vector recall over `agent_memories` (pgvector) |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — every read/write through these façades carries `tenant_id + agent_id`; vector recall is filtered, never global
- [Cognitive stack](../concerns/cognitive-stack.md) — memory is the persistence layer for classified reflection outputs
- Thin façade: eviction/TTL/ranking delegated to Postgres + Redis (not implemented in TypeScript)

## How to extend

| Need | Where |
|---|---|
| Add a new memory layer | New façade file; new table or Redis namespace; tenant-scoped reads/writes |
| Add a recall query pattern | Extend the relevant façade; if the pattern needs an index, ship a migration too |
| Tune ranking | Push to Postgres (e.g., weighted scoring in SQL) — do not implement ranking in the façade |
| Add eviction | TTL on Redis keys (`SET ... EX`) or background sweeper worker; never an in-process Map |

## Public surface

| Consumed by | What |
|---|---|
| `src/cognition/persister.ts` | Writes classified reflection outputs |
| `src/agent/core.ts` | Reads working memory per turn |
| `src/runtime/context-assembly/slice-builders/knowledge-slice-builder.ts` | Recalls semantic + vector |
| `src/skills/`, `src/tools/` | Some skills/tools read memory directly |
| `src/user-layer/resolvers/memory-resolver.ts` | User-layer recall path |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/memory/` | Per-layer façade contracts |
| `tests/unit/memory/working-ratelimit-legacy.spec.ts` | Legacy rateLimit helper removed (#270) |
| `tests/integration/leak.spec.ts` | Cross-tenant recall does not leak |

## In-flight changes

At last verification (2026-05-28):

- Working memory Redis key prefix `tenant_id + agent_id` (#231 → #241 — open)
- Embeddings rebuild scope (#239 → #244 — open) and cardinality + dim validation (#289 → #295 — open)
- Knowledge_slice cache include `agent_id` in cache key v2 (#235 → #242 — open)
- Vector memory scoping (#229 closed by #237 — merged)
- Procedural memory scoping (#230 closed by #232 — merged)
- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)
- Legacy rateLimit helper removed (#270 → #274 — merged)

Verify: `gh pr list --state open --search "memory OR vector OR working OR procedural OR semantic"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
