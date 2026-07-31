# agent

**Path:** `src/agent/`

**Purpose** — The agent's per-turn entry point and orchestration glue. Holds the prompt builder, the ReAct loop, response sanitization, pending-question gating, gap detection during a turn, success detection, and post-turn output dispatch. This is where a typed inbound turn becomes a typed outbound response, mediated by the cognitive graph and the action layer.

## Key files

| File | Role |
|---|---|
| `src/agent/core.ts` | Per-turn entry; orchestrates pre-turn, LLM call, post-turn |
| `src/agent/react-loop.ts` | ReAct loop for tool-using turns |
| `src/agent/prompt-builder.ts` | **Renders** the system + user prompt from a `TurnContextSnapshot`. Pure since #525: no repository import, no query |
| `src/agent/sanitize.ts` | Sanitizes LLM output (wraps untrusted blocks in delimiters; see prompt-injection mitigation) |
| `src/agent/output-dispatch.ts` | Dispatches outbound (text / voice / PDF / view-once) |
| `src/agent/pending-gate.ts` | Gates execution while a pending question is open |
| `src/agent/pending-resolver.ts` | Resolves user input against active pending question |
| `src/agent/gap-detector.ts` | Detects gaps in agent capability mid-turn |
| `src/agent/success-detector.ts` | Detects success signals at end of turn |
| `src/agent/reflection.ts` | Triggers reflection candidates |
| `src/agent/reflection-clustering.ts` | Clusters reflections for batch processing |
| `src/agent/execute-skill.ts` | Invokes `runSkill()` from the decision engine output |
| `src/agent/tool-execution-summary.ts` | Summarizes tool calls for the LLM follow-up |
| `src/agent/capability-revert.ts` | Reverts a capability when revocation flows fire |
| `src/agent/one-tap.ts` | One-tap response shortcut handling |
| `src/agent/pdf-cleanup.ts` | Cleans up generated PDFs after dispatch |
| `src/agent/message-update.ts` | Updates outbound message state |
| `src/agent/notification-adapter.ts` | Adapter to notification channels |
| `src/agent/scope-hash.ts` | Computes scope hash for memoization |
| `src/agent/turn-context/metrics.ts` | `maia_turn_context_*` metrics (closed label vocabulary) |
| `src/agent/turn-context/types.ts` | `LoadedSection` contract + per-section budgets |
| `src/agent/turn-context/budget.ts` | Deterministic, metered truncation |
| `src/agent/turn-context/cache.ts` | Versioned tenant+agent cache for the static context, with cross-replica invalidation |
| `src/agent/turn-context/loader.ts` | `TurnContextLoader` — produces the `TurnContextSnapshot` the renderer consumes (#525) |
| `src/db/repositories/turn-context-repos.ts` | The four batched statements behind the loader (#525) |

## Turn-context loading (issues #511, #525)

### Shape

Loading and rendering are separate since #525:

- `turn-context/loader.ts` produces a `TurnContextSnapshot` — everything the
  prompt needs, as plain values.
- `prompt-builder.ts` renders it. It imports no repository and issues no query,
  so a rendering change cannot quietly add a round-trip and a rendering test
  does not need a fake database.

The turn is still two phases, and that split is a cost decision:

1. **Cheap gate first.** `core.ts` runs the Decision Engine BEFORE `buildPrompt`,
   so a blocked or escalated turn never hydrates a prompt it is about to discard.
2. **Reasoner context second.** Only allowed turns hydrate history, entities and
   states, facts, rules, memories, hints, capabilities, gaps and the procedure.

### Cost

Measured by `tests/unit/turn-context-baseline.spec.ts` (exact counts) and
anchored against a real Postgres by
`tests/integration/turn-context-loader-batch.spec.ts` (production counter):

| entities | 1 | 10 | 100 |
|---|---|---|---|
| before #511 | 17 | 35 | 215 |
| #511, cold cache | 15 | 15 | 15 |
| #511, warm cache (operational profile v2) | 13 | 13 | 13 |
| **#525, cold cache** | **6** | **6** | **6** |
| **#525, warm cache (operational profile v2)** | **4** | **4** | **4** |
| #525, warm cache (legacy `self_state` path) | 5 | 5 | 5 |

Totals are per turn: the prompt build plus `resolveScope`'s two queries.

#511 removed the SLOPE — scope size no longer multiplies round-trips against the
fixed 10-connection pool in `src/db/client.ts`. #525 attacked the CONSTANT,
which is what the typical 1-entity turn actually pays: 17 → 6.

### The four statements

The prompt build is 4 round-trips, grouped by FAILURE SEMANTICS rather than by
table:

| statement | sections | on failure | cacheable |
|---|---|---|---|
| `loadIdentity` | operational profile v2 + `self_state` fallback | fails the turn | `identity` |
| `loadCore` | history, entities, entity states, facts, rules | fails the turn | never |
| `loadEnrichment` | memories, hints, procedure (+ its definition) | degrades its sections | never |
| `loadSelfAwareness` | skills, gaps (`mentionable`+`proposed`) | degrades its sections | `self_awareness` |

`loadCore` holds exactly the reads that used to sit in a `Promise.all` and fail
the turn; the other two hold exactly the ones that used to sit in a
`Promise.allSettled`. Mixing them would have silently upgraded an optional
section's failure into a failed turn, or the reverse.

Each statement composes the per-section reads as scalar `json_agg` subqueries
that **embed the exported query builder the single-section repository method
already uses** (`recentInConversationQuery`, `factsMentionableForScopesQuery`,
`memoryFindRelevantQuery`, …). Nothing in the batch restates a `WHERE`: a
batched read is exactly where a lost `tenant_id` predicate hides, so there is
one copy of each predicate, and the integration spec asserts the batch returns
row-for-row what the per-section methods return.

Two consequences worth knowing before editing that file:

- **Every prompt-visible `numeric` is cast to `text`.** JSON would turn
  `'0.90'` into `0.9` and silently rewrite the prompt bytes.
- **A failing optional batch retries per section** through the individual
  repository methods, so a failure is still attributed to the section that
  actually broke. The fast path costs one round-trip; only the failure path pays
  for that granularity.

### What is cached, and what is not

`CACHEABLE_RESOURCES` in `turn-context/cache.ts` is a closed union — `identity`
and `self_awareness`. Caching anything authorization-bearing is not
expressible, which is what makes a Redis outage survivable: no cached value
carries a grant, so no cached value can keep a revoked one alive. `resolveScope`
and the dispatcher's execution-time re-check always read Postgres. Keys are
`maia:turn_ctx:v1:{tenant}:{agent}:{resource}` and a degenerate scope (empty or
the legacy `'default'` literal) throws rather than producing a shared bucket.

**The rule for adding a resource:** a resource may only be cached once EVERY
mutation that changes it publishes an invalidation after commit.

- `identity` caches the rendered **operational profile v2 only**. Its publishers
  live in `src/db/repositories/profile-repos.ts` (`transition`,
  `approveAndActivateAtomic`, `adminRollbackAtomic`, `seedNewActiveAtomic`) and
  `admin-repos.ts` (the approval flow). No path mutates an active row's
  `profile_body` in place, so that coverage is complete. The legacy `self_state`
  fallback is NOT cached — `selfStateRepo.appendLearning` rewrites
  `resumo_aprendizados` from the fire-and-forget reflection path with no
  publisher — and it is read every turn. "No active profile v2" is not
  negative-cached either: the negative answer forces the uncacheable fallback
  read anyway, so an entry would save nothing while adding a staleness window.
- `self_awareness` holds skills + gaps together. #511 removed them because the
  coverage was partial; #525 restored them by supplying it. Both tables are
  written ONLY through `capabilitiesSkillRepo` and `capabilityGapsRepo`, and
  every mutating method there publishes after commit
  (`upsertConfidence`, `upsert`, `create`, `updateLevel`), so the coverage is
  complete by construction rather than by audit.
  `tests/unit/turn-context-self-awareness-invalidation.spec.ts` pins one test per
  method AND asserts the enumeration is exhaustive, so a new mutating method
  without a publisher fails the build.

Staleness has three bounds: an invalidation published after commit and fanned
out over a per-tenant Redis channel, a positive TTL, and a shorter negative TTL.
`FEATURE_TURN_CONTEXT_CACHE` is default OFF; turning it off degrades to direct
reads through the same path, never to the old waterfall.

### Budgets and degradation

**Budgets.** Every truncated section has a `max_items` AND a `max_bytes` ceiling
(`turn-context/types.ts`), and every dropped item is counted on
`maia_turn_context_truncated_total`. Truncation always takes a prefix, so the
same snapshot renders the same prompt on every replica. Policy, permission and
scope blocks have no budget entry — they are never truncatable. Budgets stay in
the RENDERER, not the loader, which is what makes the byte-identity proof in
`tests/unit/prompt-builder-golden.spec.ts` meaningful: the rendering code is the
same code, fed from a different place.

**Degradation.** A failing optional batch degrades its sections and the turn
still renders; the failure is logged as `turn_context.degraded` with the section
NAME (never its content) and counted on
`maia_turn_context_section_total{status="degraded"}`.

**Prompt bytes.** `tests/unit/prompt-builder-golden.spec.ts` compares the
rendered prompt against `tests/fixtures/prompt-golden.json`, recorded from the
pre-#525 implementation. Regenerate only when a prompt change is INTENDED:
`UPDATE_PROMPT_GOLDEN=1 npx vitest run tests/unit/prompt-builder-golden.spec.ts`.

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — LLM proposes, backend disposes
- [Cognitive stack](../concerns/cognitive-stack.md) — reflection candidates produced by `reflection.ts`, classified downstream
- [Channel/role/policy](../concerns/channel-policy.md) — pending-gate respects channel + policy

## How to extend

| Need | Where |
|---|---|
| Add a new per-turn step | New file under `src/agent/`; wire into `core.ts` |
| Add a new pending-question type | Extend `pending-questions.ts` (under `src/workflows/`); resolver in `pending-resolver.ts` |
| Add a new outbound media type | Extend `output-dispatch.ts` + corresponding `lib/` adapter |
| Change prompt structure | Edit `renderPrompt` in `prompt-builder.ts`; keep `<user_message>` / `<ocr>` / `<audio_transcript>` delimiters for injection safety, and regenerate the goldens deliberately |
| Add data to the prompt | Extend `TurnContextSnapshot` + the matching batched statement in `turn-context-repos.ts`. Do NOT add a query to the renderer — it must stay pure, and the round-trip budget is asserted exactly |

## Public surface

| Consumed by | What |
|---|---|
| `src/gateway/` | `src/gateway/queue.ts` workers invoke `core.ts` per inbound message |
| `src/workers/` | Some workers re-enter the agent for proactive turns |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/prompt-injection.spec.ts` | Sanitization wraps user content in delimiters |
| `tests/unit/agent/` | Per-step contracts |
| `tests/unit/turn-context-baseline.spec.ts` | Exact round-trip budget for 1/10/100 entities |
| `tests/unit/turn-context-warm-cache.spec.ts` | What the cache is worth, and what it refuses to hold |
| `tests/unit/turn-context-statements.spec.ts` | The batched SQL is ONE statement, tenant-scoped, numerics cast — no DB needed |
| `tests/unit/turn-context-self-awareness-invalidation.spec.ts` | Every capability/gap mutation publishes after commit |
| `tests/unit/prompt-builder-golden.spec.ts` | Prompt bytes vs goldens recorded before #525 |
| `tests/integration/turn-context-loader-batch.spec.ts` | Batch ↔ per-section parity, isolation, real round-trip count |
| `tests/integration/turn-flow.spec.ts` (if present) | End-to-end turn |

## In-flight changes

At last verification (2026-07-31):

- Skill execution via `runSkill` from decision engine (#216 — merged)
- AbortSignal plumbed from skill runner to LLM call (#221 — merged)
- Turn-context batching + versioned cache (#511 — merged as PR #524)
- `TurnContextLoader` + pure renderer + ≤8 round-trips (#525 — this change)

Verify: `gh pr list --state open --search "agent OR react OR turn"`.

---

| | |
|---|---|
| Last verified | 2026-07-31 |
| Against `main` HEAD | `7b34e7e0` |
