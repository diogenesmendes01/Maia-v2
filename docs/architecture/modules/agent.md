# agent

**Path:** `src/agent/`

**Purpose** — The agent's per-turn entry point and orchestration glue. Holds the prompt builder, the ReAct loop, response sanitization, pending-question gating, gap detection during a turn, success detection, and post-turn output dispatch. This is where a typed inbound turn becomes a typed outbound response, mediated by the cognitive graph and the action layer.

## Key files

| File | Role |
|---|---|
| `src/agent/core.ts` | Per-turn entry; orchestrates pre-turn, LLM call, post-turn |
| `src/agent/react-loop.ts` | ReAct loop for tool-using turns |
| `src/agent/prompt-builder.ts` | Builds the system + user prompt from context packet + slices |
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

## Turn-context loading (issue #511)

The turn's context is loaded in two phases, and the split is a cost decision:

1. **Cheap gate first.** `core.ts` runs the Decision Engine BEFORE `buildPrompt`.
   A turn that is blocked or escalated never hydrates a prompt, so it does not
   pay ~13 DB round-trips it is about to discard.
2. **Reasoner context second.** Only allowed turns hydrate history, entities and
   states, facts, rules, memories, hints, capabilities, gaps and the procedure.

Cost, measured by `tests/unit/turn-context-baseline.spec.ts`:

| entities | 1 | 10 | 100 |
|---|---|---|---|
| before #511 | 17 | 35 | 215 |
| after (cold cache) | 15 | 15 | 15 |
| after (warm cache) | 13 | 13 | 13 |

The slope is zero — scope size no longer multiplies round-trips against the
fixed 10-connection pool in `src/db/client.ts`.

**What is cached, and what is not.** `CACHEABLE_RESOURCES` in
`turn-context/cache.ts` is a closed union — currently just `identity`. Caching
anything authorization-bearing is not expressible, which is what makes a Redis
outage survivable: no cached value carries a grant, so no cached value can keep
a revoked one alive. `resolveScope` and the dispatcher's execution-time re-check
always read Postgres. Keys are
`maia:turn_ctx:v1:{tenant}:{agent}:{resource}` and a degenerate scope (empty or
the legacy `'default'` literal) throws rather than producing a shared bucket.

**The rule for adding a resource:** a resource may only be cached once EVERY
mutation that changes it publishes an invalidation after commit. `capabilities`
(skills catalogue) and `gaps` were cached in the first cut and removed for
exactly this reason — only profile activation published, so a revoked skill
could stay visible on another replica for a full TTL. Identity's publishers live
in `src/db/repositories/profile-repos.ts` (`transition`,
`approveAndActivateAtomic`, `adminRollbackAtomic`, `seedNewActiveAtomic`) and
`admin-repos.ts` (the approval flow).

Staleness has three bounds: an invalidation published after commit and fanned
out over a per-tenant Redis channel, a positive TTL, and a shorter negative TTL.
`FEATURE_TURN_CONTEXT_CACHE` is default OFF; turning it off degrades to direct
reads through the same path, never to the old waterfall.

**Budgets.** Every truncated section has a `max_items` AND a `max_bytes` ceiling
(`turn-context/types.ts`), and every dropped item is counted on
`maia_turn_context_truncated_total`. Truncation always takes a prefix, so the
same snapshot renders the same prompt on every replica. Policy, permission and
scope blocks have no budget entry — they are never truncatable.

**Degradation.** Optional sections load concurrently under `Promise.allSettled`;
a failure degrades that section only, and is logged as `turn_context.degraded`
with the section NAME (never its content) plus counted on
`maia_turn_context_section_total{status="degraded"}`.

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
| `tests/integration/turn-flow.spec.ts` (if present) | End-to-end turn |

## In-flight changes

At last verification (2026-05-28):

- Skill execution via `runSkill` from decision engine (#216 — merged)
- AbortSignal plumbed from skill runner to LLM call (#221 — merged)

Verify: `gh pr list --state open --search "agent OR react OR turn"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
