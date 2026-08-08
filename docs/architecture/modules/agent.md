# agent

**Path:** `src/agent/`

**Purpose** — The agent's per-turn entry point and orchestration glue. Holds the prompt builder, the ReAct loop, response sanitization, pending-question gating, gap detection during a turn, success detection, and post-turn output dispatch. This is where a typed inbound turn becomes a typed outbound response, mediated by the cognitive graph and the action layer.

## Key files

| File | Role |
|---|---|
| `src/agent/core.ts` | Per-turn entry; orchestrates pre-turn, LLM call, post-turn |
| `src/agent/react-loop.ts` | ReAct loop for tool-using turns |
| `src/agent/prompt-builder.ts` | **Pure renderer**: turns a `TurnContextSnapshot` into the system + user prompt. Imports no repository |
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
| `src/agent/turn-context/loader.ts` | `TurnContextLoader` — the ONLY place a turn reads the database |
| `src/agent/turn-context/metrics.ts` | `maia_turn_context_*` metrics (closed label vocabulary) |
| `src/agent/turn-context/types.ts` | `LoadedSection` contract + per-section budgets |
| `src/agent/turn-context/budget.ts` | Deterministic, metered truncation |
| `src/agent/turn-context/concurrency.ts` | `createReadGate` — the FIFO semaphore that caps how much of the pool one turn may hold |
| `src/agent/turn-context/cache.ts` | Versioned tenant+agent cache for the static context, with cross-replica invalidation |

## Turn-context loading (issues #511, #525)

A turn's context is **loaded** in one place and **rendered** in another, and the
split is load-bearing, not cosmetic:

- `turn-context/loader.ts` — `loadTurnContext()` is the only code in a turn that
  touches a repository. It returns a `TurnContextSnapshot`: every section as a
  `LoadedSection`, so `empty` and `degraded` can never be confused downstream.
- `prompt-builder.ts` — `renderTurnPrompt(ctx, snapshot)` is **synchronous**.
  A function that cannot `await` cannot issue a query, so "no lazy I/O inside
  rendering" is enforced by `tsc` rather than by review. `buildPrompt()` is now
  exactly `load` then `render`.

Loading itself is two phases, and that split is a cost decision:

1. **Cheap gate first.** `core.ts` runs the Decision Engine BEFORE `buildPrompt`.
   A turn that is blocked or escalated never hydrates a prompt.
2. **Reasoner context second.** Only allowed turns hydrate history, entities and
   states, facts, rules, memories, hints, capabilities, gaps and the procedure.

### Round-trip cost

Counted at the repository boundary for a typical turn (no active procedure);
`resolveScope`'s two queries are included, because a turn pays them.

| entities | 1 | 10 | 100 |
|---|---|---|---|
| before #511 | 17 | 35 | 215 |
| after #511/#524, cold, legacy `self_state` | 15 | 15 | 15 |
| after #511/#524, cold, operational profile v2 | 14 | 14 | 14 |
| **after #525, cold, legacy `self_state`** | **13** | **13** | **13** |
| **after #525, cold, operational profile v2** | **12** | **12** | **12** |
| after #525, warm cache, operational profile v2 | 11 | 11 | 11 |

The slope is zero — scope size does not multiply round-trips against the fixed
10-connection pool in `src/db/client.ts`. That, not the cache, is where the win
is: the cache is worth exactly one query, because only the operational-profile
branch is cacheable (see below).

### Concurrency ceiling

Total cost and **instantaneous** cost are separate ceilings, and the pool needs
both. The table above says what a turn costs; it says nothing about how much of
the shared pool a turn may hold while paying it. The first cut of #525 answered
that badly: the critical group (5 reads) and the optional group (5) are both
started before either is awaited, so a cold-cache turn with an unresolved
procedure issued **ten** statements in one tick against `max: 10`. One turn
could hold every connection in the process, and every other turn — of every
other tenant — queued behind it. PR #541's review caught it.

`TURN_CONTEXT_MAX_CONCURRENT_READS = 6` (`turn-context/types.ts`) is the
replacement ceiling, applied as ONE shared FIFO semaphore
(`turn-context/concurrency.ts`) over the critical **and** optional groups
together. Six is not a new number: it is the ceiling the pre-#525 code enforced
and documented, and the shared version is strictly stronger than the per-group
one it restores.

| | |
|---|---|
| Pool (`src/db/client.ts`) | `max: 10`, process-wide |
| One turn's ceiling | 6 statements in flight |
| Left for everyone else | ≥ 4 connections, always |

A semaphore rather than a phase split, because running the groups in sequence
would cap concurrency at 5 but reintroduce half the waterfall #525 removed —
the turn would pay `max(critical) + max(optional)` instead of
`max(everything)`. All ten tasks stay in one pipeline; only how many run at once
is bounded. FIFO matters: the critical group is enqueued first, so it holds the
first permits and a late optional read can never push the turn's critical path
back.

The gate never catches, retries or reorders, so the failure contract is
untouched — a critical rejection still fails the turn, an optional rejection
still degrades only its own section. The ceiling is per TURN, not per process:
bounding one turn's blast radius is the point, and a process-wide gate would
just move cross-turn queueing out of the pool (which has
`connectionTimeoutMillis`) and into the application (which would not).

`tests/integration/turn-context-pool-fairness.spec.ts` is the enforcement — two
simultaneous `loadTurnContext` calls against the real pool, with barriers that
hold real connections, asserting both that the peak never exceeds 6 **and** that
it reaches 6 (so "fixed by serialising" fails too). Changing this number without
changing `max` in `src/db/client.ts` changes how much of the pool one tenant can
take; the two belong in the same review.

`TURN_ROUND_TRIP_BUDGET` in `turn-context/types.ts` is the enforced ceiling and
`tests/unit/turn-context-round-trips.spec.ts` is its enforcement — it asserts the
EXACT count per path, names every read, and fails the build when a new one
appears. In production the same number is published on
`maia_turn_context_db_queries{phase="loader"}` by the counter frame in
`buildPrompt` (`src/db/query-counter.ts`).

**What #525 removed, and why it was removable.** Both cuts are duplication, not
behaviour:

- the gap catalogue was read twice — `listByLevel('mentionable')` for the
  self-awareness clause and `listByLevels([mentionable, proposed])` for the
  "known limitations" block. The second is a strict superset, so the first is now
  a filter over rows already in hand;
- entity NAMES and entity STATES were two reads of the same entity set joined on
  `entity_states.entidade_id = entidades.id`. `entidadesRepo.byIdsWithState` is
  that LEFT JOIN. The same change bound `(tenant_id, agent_id)` on
  `entidadesRepo.byIds`, which had been matching on id alone.

The two halves of that JOIN have **different cardinality**, and the first cut
got it wrong (PR #541 review, finding 2): it applied one `LIMIT 500` to the
joined row set, but the pair it replaced capped only the STATE read —
`entidadesRepo.byIds` never had a limit. Past row 500 the ENTITY vanished, the
renderer's `ent?.nome ?? eid` fell through, and the scope/permissions block
printed a raw UUID instead of a name — in a block that has no `SECTION_BUDGETS`
entry precisely because it is never truncatable. A scope can exceed 500 entities
whenever they share permission profiles, since `profilesRepo.byIds`'s own cap is
on distinct PROFILES. The entity side is now unbounded (bounded only by
`ids.length`, which the caller controls); `stateLimit` caps the state projection
alone, and a capped row comes back as `state: null` — the same shape an entity
with no state row already had. Still one statement.
`tests/integration/turn-context-scope-cardinality.spec.ts` holds it with 501
entities on one profile.

**The ≤8 target of issue #525 is NOT met** (`TURN_ROUND_TRIP_TARGET`). Every
remaining read is a different table, so closing the gap needs cross-table
statements rather than de-duplication. The candidates, with what each is worth:

| merge | saves | why not yet |
|---|---|---|
| `permissoes ⋈ permission_profiles` in `resolveScope` | 1 | authorization path; changing it is out of scope for a performance change |
| `agent_capabilities_skill ∪ agent_capability_gaps` | 1 | needs a `UNION ALL` over a projected common shape |
| `agent_facts ∪ learned_rules` | 1 | same, and `learned_rules.confianca` is `numeric` — a jsonb round-trip renders `0.8` where the prompt says `0.80`, changing the bytes |
| `memory_entry ∪ behavioral_hint` | 1 | the memory read carries a `LIMIT`, so its union branch needs a subquery |
| `operational_profile_versions ∪ self_state` | 1 (legacy path only) | would read `self_state` unconditionally, on every turn |

None of these is expressible as a plain drizzle join, and none can be verified
without a live Postgres, so they belong in a change that can run the integration
suite while making them.

**What is cached, and what is not.** `CACHEABLE_RESOURCES` in
`turn-context/cache.ts` is a closed union — currently just `identity`. Caching
anything authorization-bearing is not expressible, which is what makes a Redis
outage survivable: no cached value carries a grant, so no cached value can keep
a revoked one alive. `resolveScope` and the dispatcher's execution-time re-check
always read Postgres. Keys are
`maia:turn_ctx:v1:{tenant}:{agent}:{resource}` and a degenerate scope (empty or
the legacy `'default'` literal) throws rather than producing a shared bucket.

**The rule for adding a resource:** a resource may only be cached once EVERY
mutation that changes it publishes an invalidation after commit. Three things
have already been removed under that rule, and #525 did NOT put them back:

- `capabilities` (skills catalogue) and `gaps` — only profile activation
  published, so a revoked skill could stay visible on another replica for a
  full TTL. Issue #525 asked for them back with complete publisher coverage;
  they stay out, deliberately. The publisher surface is skill activation,
  rollback and revocation plus every gap level transition INCLUDING the ones the
  learning loop originates (`gap-detector.ts` → reflection classification →
  `capabilityGapsRepo.upsert` / `updateLevel`), which spans mutation sites in
  `src/cognition/` and `src/control-plane/` that this change does not own.
  Half-coverage reads as a guarantee, and two saved queries are not worth
  showing an agent a capability it no longer has;
- the legacy `self_state` fallback inside `identity` —
  `selfStateRepo.appendLearning` rewrites `resumo_aprendizados` from the
  fire-and-forget reflection path with no publisher.

So `identity` caches the rendered **operational profile v2 only**; the
`self_state` fallback is read every turn. Identity's publishers live in
`src/db/repositories/profile-repos.ts` (`transition`,
`approveAndActivateAtomic`, `adminRollbackAtomic`, `seedNewActiveAtomic`) and
`admin-repos.ts` (the approval flow). No path mutates an active row's
`profile_body` in place, so that coverage is complete.

Staleness has three bounds: an invalidation published after commit and fanned
out over a per-tenant Redis channel, a positive TTL, and a shorter negative TTL.
`FEATURE_TURN_CONTEXT_CACHE` is default OFF; turning it off degrades to direct
reads through the same path, never to the old waterfall.

**Budgets.** Every truncated section has a `max_items` AND a `max_bytes` ceiling
(`turn-context/types.ts`), and every dropped item is counted on
`maia_turn_context_truncated_total`. Truncation always takes a prefix, so the
same snapshot renders the same prompt on every replica. Policy, permission and
scope blocks have no budget entry — they are never truncatable.

**Degradation.** Optional sections (memories, hints, capabilities, gaps,
procedure) load concurrently (under the shared read gate above) and
independently; a failure degrades that section
only, is logged as `turn_context.degraded` with the section NAME (never its
content), counted on `maia_turn_context_section_total{status="degraded"}`, and
reaches the renderer as `degraded(fallback, reason)` — which renders as an
ABSENT section, never as a placeholder the model could read as truth. Critical
sections (identity, history, entities+states, facts, rules) still fail the turn:
fail-closed beats a prompt that quietly omits who the agent is.

**Tenant isolation.** The loader adds no scope of its own — every read goes
through a repository that binds `(tenant_id, agent_id)` from ALS, and those
getters throw on a missing, empty or `'default'` scope. Batching narrows nothing:
a batched read is the same predicate with an `IN (…)` on a non-identifying
column, never a dropped tenant predicate.

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
| Change prompt structure | Edit `prompt-builder.ts`; keep `<user_message>` / `<ocr>` / `<audio_transcript>` delimiters for injection safety |
| Add data to the prompt | Load it in `turn-context/loader.ts` (never from a render helper), add it to `TurnContextSnapshot`, then render it. Bump `TURN_ROUND_TRIP_BUDGET` and the counts in `turn-context-round-trips.spec.ts` — a new read must be a reviewed increase, not a surprise |

## Public surface

| Consumed by | What |
|---|---|
| `src/gateway/` | `src/gateway/queue.ts` workers invoke `core.ts` per inbound message |
| `src/workers/` | Some workers re-enter the agent for proactive turns |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/turn-context-round-trips.spec.ts` | The round-trip budget: exact counts, the named read set, and that the renderer costs zero |
| `tests/unit/turn-context-renderer-purity.spec.ts` | The renderer runs with every repository rigged to throw |
| `tests/unit/turn-context-baseline.spec.ts` | Zero slope + `resolveScope` batching and its cross-tenant counterfactual |
| `tests/unit/turn-context-read-gate.spec.ts` | The semaphore's contract: ceiling, FIFO order, permit released on rejection |
| `tests/integration/turn-context-pool-fairness.spec.ts` | Two concurrent turns on the real pool: peak ≤ 6, peak = 6, fairness |
| `tests/integration/turn-context-scope-cardinality.spec.ts` | 501 entities on one profile: every name rendered, no UUID in the prompt |
| `tests/unit/prompt-injection.spec.ts` | Sanitization wraps user content in delimiters |
| `tests/unit/agent/` | Per-step contracts |
| `tests/integration/turn-flow.spec.ts` (if present) | End-to-end turn |

## In-flight changes

At last verification (2026-05-28):

- Skill execution via `runSkill` from decision engine (#216 — merged)
- AbortSignal plumbed from skill runner to LLM call (#221 — merged)
- Turn-context loader integrated + pure renderer (#525 — this change). Still
  open in #525: the ≤8 round-trip target, and returning `capabilities`/`gaps`
  to the cache (decision to keep them out is recorded above).
- PR #541 review follow-up: the shared read gate (finding 1) and the JOIN's
  entity-side cardinality (finding 2), both described above.

Verify: `gh pr list --state open --search "agent OR react OR turn"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
