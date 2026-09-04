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
| `src/agent/output-dispatch.ts` | Dispatches outbound (text / voice / PDF / poll / view-once). Desde #631, **commita a intenção de resposta no outbox durável ANTES de qualquer chamada ao canal**; desde #634 isso vale para TODOS os ramos (voz incluída) e a mídia entra por `storage_object` — ver abaixo |
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

That spec counts repository CALLS, with `src/db/repositories.js` mocked. It is
the right shape for asserting the read SET, but it rests on an assumption it
cannot check — one repository method is one statement — and a method that grew a
second statement would leave it green at 13 while production paid 14.
`tests/unit/turn-context-statement-count.spec.ts` closes that gap without a
database by mocking one layer lower: only `pg` is faked, at `client.query`, the
exact seam `instrumentQueries` hooks. Everything above it is production —
`buildPrompt`, `loadTurnContext`, the real repositories, the real drizzle SQL
compilation — so the 13 it measures is a count of statements that would have
gone down a socket. It reads the count twice per assertion (the production
counter, and the fake client's own log) and fails if the two disagree, so the
instrumentation is under test rather than trusted. Because the whole read set is
materialised there as SQL text, it also asserts that every one of the 13
statements carries a `tenant_id` AND an `agent_id` predicate — a cheap
unit-lane companion to the real isolation proof in the integration suite, which
is why it is part of `npm run test:leak`. It says nothing about whether a
predicate binds the RIGHT value; that stays with
`tests/integration/turn-context-batch-repos.spec.ts`.

**The `context.load` span.** `loadTurnContext` is wrapped by
`instrumentContextLoad` (`src/observability/instrumentation.ts`,
`stage="turn_context"`) at the EXPORTED entry point, delegating to
`loadTurnContextInner` — so "one span per turn-context load" is structural and
no second call site can be forgotten. The wrapper emits the span and NOTHING
else: duration and round-trips for the same load are already
`maia_turn_context_load_duration_ms` / `maia_turn_context_db_queries` above, and
the review of PR #554 retired the parallel `maia_context_load_*` family rather
than measure one operation twice. The span sits one level below `buildPrompt`
on purpose: a span around `buildPrompt` would also cover the render and would
contain `prompt.render`, which `SPAN_PARENT` declares a SIBLING of
`context.load` under `turn`.

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

**The ≤8 target of issue #525 was RETIRED by owner decision (2026-09-02)** —
`TURN_ROUND_TRIP_TARGET` no longer exists in the code:

> "#525: escolho reescrever a meta em termos de latência. Não vamos pagar cerca
> de 3× no p95 apenas para atingir ≤8. A contagem continua como guardrail, com
> crescimento O(1); p95, p99, throughput e erros passam a ser os critérios
> principais."

The acceptance criterion is latency now, judged by the gate; the statement
count survives as an **O(1)-growth guardrail** (count at N=100 must equal count
at N=1, zero tolerance — enforced both by the round-trips spec and by the gate
on measured turns), and the absolute ceiling is a report line. For the record,
the merge candidates that the retired target pointed at, with what each was
worth:

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

**And they would buy almost nothing.** That is now measured rather than argued —
see "The performance gate" below. The `warm` arm already runs the turn with
**nine** reads instead of ten (the identity read is served from the process
cache), and its p95 does not improve: 60.1 ms cold against 66.5 ms warm on the
same run, i.e. one fewer round-trip is inside the run-to-run noise. Replaying
each measured turn's read latencies through the same 6-permit gate with the two
`UNION ALL` merges applied models a saving of **1.9 ms (3.2 % of p95) cold** and
**4.4 ms (6.7 %) warm**. Ten tasks against six permits is two waves; eight tasks
against six permits is still two waves, so the merges shorten the second wave
instead of removing it. Whether 13 stays the budget is the owner's call, but the
number that call would be made on is no longer a guess.

### The performance gate (`npm run turn:bench`)

`scripts/turn-context-benchmark.ts` is the executable form of the acceptance
criteria for #525. It drives the **whole turn** — `resolveScope`
(`src/governance/permissions.ts`) followed by `buildPrompt`, the production call
site that publishes `maia_turn_context_load_duration_ms{phase="loader"}` — against
a **real Postgres** through the real `max: 10` pool, with 50 tenant/agent pairs,
concurrency 20, scopes of 1/10/100 entities, and two arms:

| arm | `FEATURE_TURN_CONTEXT_CACHE` | identity | reads per turn |
|---|---|---|---|
| `cold` | off (the production default in every generated fixture) | read from Postgres every turn | 10 + 2 (`resolveScope`) |
| `warm` | on, pre-warmed per pair | served from process memory | 9 + 2 (`resolveScope`) |

**Issue #700 — the boundary the harness measures.** Until #700 it measured
`buildPrompt` only: `buildContext` fabricated the scope in memory and the
fixture seeded neither `permissoes` nor `permission_profiles`, so a regression
living in `resolveScope` passed the gate unseen and the "whole turn budget"
criterion was emitted as `n/a` (which fails in `gate` mode — the containment).
The scope is now resolved **in Postgres, inside the turn's clock**, by the same
`resolveScope` `core.ts` calls. Because `resolveScope(pessoa)` returns *all* of
that person's permissions and takes no cardinality argument, the 1/10/100 scale
IS the resolved scope size: the fixture seeds **three people per pair**, with 1,
10 and 100 `permissoes` rows each pointing at a distinct `permission_profiles`
row (100 per pair, under the 500-row cap `profilesRepo.byIds` enforces). The
interlocutor/conversation fixture is seeded for all three — seeding it for one
would have silently changed what the rest of the benchmark measures.

The two scope reads are sequential and run *before* the `ReadGate`, so they add
2 to **reads per turn** and nothing to **peak concurrent reads**, which stays at
6. The turn's stopwatch opens before `resolveScope` and closes after
`buildPrompt`, and that boundary is computed in exactly one place
(`measureTurn`) precisely so it can be asserted rather than merely arranged:
subtracting the stage from the turn's clock would restore the old coverage while
leaving the counters, the flag and the cardinality untouched. `COBERTURA_DA_MEDICAO.resolve_scope_medido` is a label carried into the
fingerprint (so a baseline from the old coverage is refused), never the proof:
the "whole turn budget" criterion reads the measured numbers, so flipping the
flag without the measurement produces an evaluated, failing criterion.

Repositories are **wrapped, not mocked**: the real query runs, and the wrapper
only stamps start/end so every read can be attributed to its turn. That is what
makes "peak concurrent reads for one turn" a measurement rather than a re-reading
of the gate's own bookkeeping.

**Measuring and gating are different runs.** `--mode` is declared, never inferred
from a flag buried in the command line: `gate` (the default) emits the verdict,
`measure` emits an absolute measurement and says in capitals that it is **not**
the gate, `self-test` proves the gate reproves over synthetic values. The rule
that ties it together: **a criterion that could not be evaluated (`n/a`) fails in
`gate` mode** — `Verdict.skipped === true` implies `Verdict.passed === false`.
Not-evaluated used to mean approved, and that equality is what let a clean
checkout — which by construction has no baseline, since the file is not checked
in — exit 0 as if it had cleared the relative criterion. Recording a baseline
requires `--mode measure`, so the run that judges can never mint the reference it
will later be judged against.

What the gate decides (exit code 0/1), and why each one is there:

| criterion | limit | why |
|---|---|---|
| p95 of context load | ≤ 600 ms | the owner's ceiling |
| p99 of context load | ≤ 1 s | ditto |
| errors, timeouts | 0 | a fast turn that fails is not a fast turn |
| peak concurrent reads **per turn** | ≤ 6 | `TURN_CONTEXT_MAX_CONCURRENT_READS`, read from the code, never typed into the gate |
| peak concurrent reads **reaches** 6 | = 6 | otherwise "fixed by serialising" would pass the row above |
| `resolveScope` reads per turn | ≥ 1 (the count itself is measured and REPORTED, not fixed) | #700, rewritten by the #525 owner decision. 0 means the scope was fabricated in memory (or the fixture lost the tables). The old `= 2` upper bound would have failed the #693 fusion (`forPessoaComProfile`, one read) *by construction*; the N+1 it caught now falls to the O(1) row below, which sees an N+1 in **any** stage, not just the scope. The count comes from the same per-turn instrument as peak reads, so it asserts what *ran* |
| statements per turn are O(1) in cardinality | count envelope at N=100 **equals** N=1, zero tolerance | the guardrail the owner kept when retiring the ≤8 target. The absolute ceiling (12, 13…) is a report line, not a criterion |
| resolved scope size | 1–100, zero mismatches against the seeded cardinality | reads that happened and returned nothing are not a measurement; this also catches a permission dropped by a batch cap |
| p95 of the `resolveScope` stage | ≤ 600 ms | deliberately conservative — eating the whole turn budget in the scope stage alone is pathological. The sharp defence is the total p95, which now includes the stage |
| whole-turn budget (`resolveScope` + `buildPrompt`) | the scope-evidence rows above, on every arm | the aggregate #700 names. It reads the measured numbers, not the coverage flag |
| distinct tenants concurrently in flight | ≥ 10 | the load must really be multi-tenant |
| pool sampling actually observed the run | samples > 0, blind gap ≤ 10× `--sample-ms` | the criterion below is worthless without it — see the trap |
| pool drains (**normal profile**, paced) | during load, never saturated 60 s straight | see the trap below |
| pool drains (**saturation profile**, `--think-ms 0`) | after the producer stops | demanding it *during* load is arithmetically impossible — the owner's ruling |
| `…load_duration_ms{phase="loader"}` observed every turn | count = turns | the gate defends the series the operator's alert reads |
| p95 and p99 vs baseline | ≤ baseline × 1.10, **same fingerprint** | the MAIN criteria since the #525 decision. The margin is a named parameter (`MARGEM_RELATIVA_DEFAULT`, `--relative-margin`); 10 % because baseline and candidate are measured in the same window — the cross-day variance that justified the old +20 % is excluded by protocol |
| throughput vs baseline | ≥ baseline × 0.90 | a "faster" turn that pays its p95 with queueing shows up here |
| per-cardinality p95/p99 vs baseline | ≤ baseline × 1.10 at each of N=1/10/100 | a regression that lives only in the N=100 turns must not hide inside the arm aggregate |
| load average around each arm | recorded before/after (report line) | the "same window and conditions" evidence the owner's protocol requires; on a 4-CPU host, load > 4 means do not measure |
| load shape | 50 pairs, concurrency 20, 1/10/100 | a gate run on 4 tenants is not this gate |

**The saturation trap.** Comparing "longest saturated streak < 60 s" and nothing
else is a false green, and the first cut of this harness produced one: a 60.1 s
run reported 572 of 572 samples saturated — 100 % of the time — with a longest
streak of 57.2 s, therefore "< 60 s", therefore green. The streak is bounded by
the run's own length, so on its own that test only asks whether the run was
short. The criterion is now what the sentence means: the pool must **drain** —
`saturated_samples < samples`, an exact count — *and* never stay saturated for
60 s straight.

That exact count had its own hole: `samples === 0` was read as "drained". A run
with `--sample-ms` larger than its own duration, or one where the event loop
starved the sampler, produced 0/0 and cleared one of the gate's central criteria
with no observation at all. Observation is now a criterion of its own — zero
samples fails, and so does a blind gap wider than 10× the requested period, ends
included — and `--sample-ms` is validated against the window it has to resolve.
The saturated streak is measured from **timestamps**, not by accumulating the
requested period: `streak += periodMs` counts periods *asked for*, so a starved
sampler under-reports without bound, and it starves exactly when the machine is
under the load worth measuring. Ten samples spread over 61 s used to read as
"1 s saturated". The accounting lives in `createPoolSaturationTracker` +
`poolMetricsFromSummary`, separate from the `setInterval`, so the boundary from
sampler to verdict is testable — fixing only the evaluator would leave `runArm`
emitting `pool_samples: 0` with the spec green and the real run still lying.

**The baseline fingerprint.** The file records the *shape* of the run that
produced the number, and an incompatible shape makes the comparison **refused**,
not merely flagged: `pairs`, `concurrency`, `think_ms`, `identity`,
`cardinalities`, `pool_max`, `max_concurrent_reads`, `turns`, `sustain_s`,
`cobertura`.
`think_ms` alone moves p95 from 28.8 ms to 187.7 ms on this host, and run length
moves it just as hard — 600 turns (5.7 s) measured p95 118.6 ms where 60 s
sustained (7 389 turns) measured 22.4 ms, same host and code minutes apart,
because the warm-up transient is amortised over 12× more turns. Comparing across
either manufactures a false green or a false red out of a change in *load*, not
code. Host, Node version, `timeout_ms` and `sample_ms` are recorded but not
compared — a fingerprint that invalidates the baseline every run is noise the
operator learns to ignore. A pre-fingerprint file is refused too: it cannot prove
what load it measured. The practical consequence: **record the baseline with the
same command the gate runs**.

**Two profiles, two drain criteria.** The owner settled the closed-loop
arithmetic by splitting what each profile measures: the normal profile paces the
load (`--think-ms 150`) and keeps the drain criterion as it was; the un-paced
profile (`--think-ms 0`) becomes a *saturation test*, where zero errors/timeouts
still holds but drainage is required **after the producer stops**, not while
twenty turns are continuously replaced. So every run now has two phases — load
and drain (`--drain-window-ms`, default 2 s) — with the boundary marked by
timestamp. Without that window there is no drain phase to observe at all: the
generator is closed-loop, so by the time the workers return every turn has
finished and the sampler used to be stopped at that same instant. Samples from
the load phase alone are not evidence of drainage, and that case is `n/a` — which
fails in gate mode, for the same reason zero samples does. Measured here on the
saturation profile: 40/40 samples saturated during load, 0/20 during the drain
window, queue empty 39 ms after the producer stopped.

**Pacing is a parameter, not decoration.** The generator is closed-loop, so with
`--think-ms 0` twenty turns are always in flight; at up to 6 permits each against
10 connections the pool queue cannot empty, by arithmetic. Measured on a 4-vCPU
host with a local Postgres, `cold` arm, concurrency 20: the un-paced profile
yields 90.7 turns/s at p50 187.7 ms with 100 % of samples saturated, while
`--think-ms 150` yields **more** throughput (102.1 turns/s) at p50 28.8 ms with
68 % saturated and a 1.3 s longest streak. Past the knee, the queue only adds
waiting. The default pacing is therefore 150 ms; `--think-ms 0` remains valid as
the stress profile, where the drain criterion is red by construction.

**Baseline.** `scripts/turn-context-baseline.json` holds the p95/p99 per arm,
the host it was measured on, and a note saying whether it is a first measurement
or a re-record. **It is not checked in**, and `.gitignore` keeps it that way. A
baseline is a measurement of one machine at one moment, and shipping one file as
if it were a shared reference makes the relative criteria red on arrival for
everybody else: a baseline recorded here at p95 67.0 ms (`cold`) / 75.9 ms
(`warm`) was replayed on the same 4-vCPU host in a later container and measured
135.5 / 118.5 ms and then 154.1 / 114.9 ms — the same code, +56 % to +130 % over
the recorded number, with the gate's own ceilings (600 ms / 1 s) never
threatened. So each host and each CI lane records its own on first run with
`--mode measure --write-baseline`, and without one the harness reports the
relative criteria as `n/a` — **which fails the gate**, because the gate promises
`p95/p99 ≤ baseline × 1.10` (and `throughput ≥ baseline × 0.90`) and cannot
stamp what it never measured. A gate run never
writes a baseline as a side effect, and `--write-baseline` outside `--mode
measure` is refused with exit 2. Not versioning the file was right; letting the
resulting no-baseline state exit 0 turned "exceptional state that warns" into the
guaranteed state of every clean checkout, which is the defect that got fixed
here.

What survives across hosts is the absolute part of the gate — 600 ms p95, 1 s
p99, zero errors, peak ≤ 6, the pool draining, the metric covering every turn and
the load having the shape the issue specifies. Those are the criteria to read
first when a run is red.

Proving a gate is proving that it **rejects**.
`tests/unit/scripts/turn-context-gate.spec.ts` feeds synthetic arm results into
the pure `evaluateGate` and asserts a non-zero exit for each criterion —
including the two that are easy to get backwards (a peak that is too *low*, and
a pool that never drains inside a sub-60 s run). `--inject` is refused unless
`--self-test` is also passed, so it cannot become a back door that turns the
gate into a rubber stamp.

Procedure, thresholds and what to do with a red run:
[`docs/runbooks/operational.md` §11](../../runbooks/operational.md).

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

## Pending gate: os desfechos, e por que `race_lost` é terminal

`pending-gate.ts` roda ANTES do ReAct e devolve um `GateResult`. Cada `kind` é
uma instrução diferente para `core.ts` — colapsar dois deles no mesmo valor é o
defeito que a issue #545 destravou:

| `kind` | O que aconteceu | O que `core.ts` faz |
|---|---|---|
| `no_pending` | não havia pendência aberta, ou a flag está desligada | turno normal (ReAct) |
| `resolved` | esta mensagem resolveu a pendência; `resolveAndDispatch` já executou e auditou a ação | conclui: `completed` / `pending_action_resolved` |
| `race_lost` | a mensagem foi classificada como RESPOSTA à pendência e **perdeu** a corrida para outra resposta | conclui: `ignored` / `pending_race_lost` — **sem ReAct** |
| `cancelled` | a TENTATIVA perdeu a posse do turno (lease vencida / takeover) enquanto o gate rodava | lança `TurnOwnershipLostError('pending_gate')` — sai **sem concluir, sem retry, sem `processada_em`** |
| `unresolved` | havia pendência, mas esta mensagem não a resolveu (`low_confidence`, `topic_change`) | turno normal (ReAct) |

**Por que `cancelled` é um `kind` e não um `unresolved`** (issue #507, revisão da
PR #599). Ele não fala sobre a pendência: fala sobre a POSSE. Colapsá-lo em
`unresolved/low_confidence` — que foi o que a primeira entrega fez — devolve ao
fluxo normal uma tentativa que já não é dona do turno, e entre
`checkPendingFirst` e o guard do ReAct existem ~700 linhas de pipeline:
`captureInboundForOutreach` (muta estado de scheduling), o grafo pre-turn (grava
decisões e pode iniciar execuções) e o Decision Engine (pode BLOQUEAR e
responder ao usuário). O guard do ReAct chega tarde demais para todos eles.

**Onde vive o tratamento de `TurnOwnershipLostError`.** Num lugar só: o `try`
que envolve `runWithTurnExecution` em `runAgentForMensagemInner`
(`src/agent/core.ts`) — isto é, exatamente o ponto onde o escopo de execução da
tentativa ABRE. Fazer o handler coincidir com o escopo torna "roda com posse" e
"coberto pelo tratamento" a MESMA região por construção: um limite de efeito
novo, em qualquer ponto do pipeline, já nasce coberto. Antes o `try` cobria só
`runReActLoop`, e por isso nenhum limite anterior podia lançar.

O desfecho é sempre o mesmo, e é o único honesto: **sair sem concluir, sem
agendar retry e sem carimbar `processada_em`.** Quem tem a lease vigente decide
o desfecho; um retry nosso seria gravação em turno alheio, que é o que a #504
proíbe.

**Por que `race_lost` não pode voltar a ser `no_pending`.** Sob concorrência, duas
respostas chegam para a mesma pergunta: uma vence o `SELECT … FOR UPDATE` em
`pendingQuestionsRepo.findActiveForUpdate` e a outra perde. O invariante de
exatamente-uma-vez está intacto — a ação é despachada uma vez só (veredito da
#545, PR #562). O problema é o destino da perdedora: com `no_pending`, `core.ts`
lê "não havia pendência nenhuma" e manda a mensagem para o ReAct. Um `"sim"` que
significava "opção sim da pergunta X" vira comando novo e livre para o LLM —
mudança de significado num caminho que, por definição, só existe sob
concorrência, ou seja, raro e difícil de reproduzir.

Reaproveitar a mensagem perdedora no futuro é possível, mas exige **reavaliação
explícita contra o estado novo** — nunca por colapso em `no_pending`.

**As duas travessias do lock, e por que cancelamento e topic change divergem.**
O gate pega o lock em dois lugares: no ramo de cancelamento/topic change
(`applyTx`) e dentro de `resolveAndDispatch`. Perder a corrida em qualquer um
deles é auditado com a mesma ação, `pending_race_lost`, com `stage` em
`metadata` (`resolution` · `cancellation` · `topic_change`) — antes, o ramo de
cancelamento/topic change não deixava rastro nenhum.

O **desfecho**, porém, difere de propósito:

- **`cancellation` → terminal.** `"cancela"` / `"deixa pra lá"` só significa algo
  amarrado à pendência que já não existe. Solto, é um comando de cancelamento
  sem alvo — exatamente o risco que a regra fecha.
- **`topic_change` → segue para o ReAct**, devolvendo `unresolved/topic_change`.
  O classificador declarou que a mensagem **não** é resposta à pendência, é
  assunto novo: o significado dela não muda com a race, e o caminho SEM race
  também devolve `unresolved/topic_change`. Torná-la terminal faria a mesma
  pergunta do usuário ser respondida ou descartada conforme um sorteio de
  timing, e perderia em silêncio um pedido legítimo. O que estava errado ali era
  o `no_pending` (que mente sobre ter havido pendência) e a ausência de trilha.

**Trilha de auditoria do desfecho terminal** — duas linhas, dois fatos
independentes: `pending_race_lost` (escrita dentro da transação que segurava o
lock) diz que a corrida foi perdida; `turn_ignored_by_policy` (de `concludeTurn`,
com `outcome = pending_race_lost`) diz que o turno foi descartado por causa
disso. Ver [`runtime.md`](runtime.md) e o runbook
[`turn-state-machine.md`](../../runbooks/turn-state-machine.md).

## Saída: o commit vem antes do canal (issue #631, fatia B da #506)

`output-dispatch.ts` era o arquivo que a auditoria da #506 nomeou: o ledger em
caminho **opcional e fail-open** (`claimOutboundLedgerOrFailOpen` — *"log the
issue and proceed as if there's no prior row"*), e enviar e persistir separados
por uma janela de crash. Desde #631 a ordem de **todo** ramo é fixa:

```
assertOutboundOwnership  →  ledger legado (#227)  →  COMMIT durável  →  canal
```

- **"Antes" é literal.** Entre `commitOutboundOrRefuse(...)` e a chamada ao
  canal não existe nenhum `await`. Cada await ali seria uma janela nova com a
  resposta já comprometida.
- **O ledger legado vem primeiro de propósito.** Ele responde "alguém já
  respondeu este turno?", e um `skip` significa que não vamos enviar —
  commitar antes deixaria o turno em `outbound_pending` com uma linha durável
  que ninguém pretende entregar.
- **A falha do commit é relançada, nunca engolida**, e reclassificada como
  `OutboundDeliveryError(delivered: false)`: nada foi ao canal, então o caller
  recebe `not_sent` (retry seguro) em vez do conservador `sent_no_persist`.
- **`recordCommittedDelivery` é provisório e declarado como tal.** Enquanto o
  delivery worker de #632 não existe, quem entrega é o mesmo processo, e sem
  fechar a linha toda saída entregue ficaria `pending` — de modo que a #632, ao
  subir, varreria e **reenviaria** mensagens já recebidas. Ele nunca lança: o
  efeito externo já ocorreu, e uma exceção ali só trocaria uma linha
  desatualizada por um turno abortado.

Desde #634 **todo** ramo commita — inclusive voz, que #631 deixou como exceção
declarada — e a chamada ao canal acontece dentro do escopo de egresso do outbox
(`withOutboxEgress`). Fora dele a fronteira única RECUSA o envio; ver
[`runtime.md` § Onde a mídia de saída mora, e a trava do envio direto](runtime.md).

A mídia de documento e de voz entra por `storage_object`
(`src/runtime/outbound/media-store.ts`), não mais por `local_path`: o objeto é
escrito antes do commit e só é descartado quando a entrega é confirmada, de modo
que uma segunda tentativa encontra os MESMOS bytes.

Onde a mecânica mora: [`runtime.md` § Outbox de saída](runtime.md) (o contrato,
a transação e a flag) e `src/db/repositories/outbound-outbox-repo.ts` (a
transação única).

## Patterns it follows

- [Action layer](../concerns/action-layer.md) — LLM proposes, backend disposes
- [Cognitive stack](../concerns/cognitive-stack.md) — reflection candidates produced by `reflection.ts`, classified downstream
- [Channel/role/policy](../concerns/channel-policy.md) — pending-gate respects channel + policy

## How to extend

| Need | Where |
|---|---|
| Add a new per-turn step | New file under `src/agent/`; wire into `core.ts` |
| Add a new pending-question type | Extend `pending-questions.ts` (under `src/workflows/`); resolver in `pending-resolver.ts` |
| Add a new outbound media type | Extend `output-dispatch.ts` + corresponding `lib/` adapter — **e** a união de payload em [`src/runtime/outbound/contract.ts`](../../../src/runtime/outbound/contract.ts) + o CHECK `outbound_messages_payload_type_check` (migração 121) + o inventário de [`src/runtime/outbound/send-paths.ts`](../../../src/runtime/outbound/send-paths.ts), na mesma PR. Um tipo que existe só no schema é row que nenhum worker entrega: `pending` eterno. A união só admite o que `LineOutput` (`src/gateway/line-output.ts`) declara como primitiva — por isso não há `image` nem `video` hoje |
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
| `tests/unit/turn-context-statement-count.spec.ts` | The same budget counted in SQL STATEMENTS (real repos + real drizzle, only `pg` faked), plus tenant+agent scoping on every statement |
| `tests/unit/turn-context-renderer-purity.spec.ts` | The renderer runs with every repository rigged to throw |
| `tests/unit/turn-context-baseline.spec.ts` | Zero slope + `resolveScope` batching and its cross-tenant counterfactual |
| `tests/unit/turn-context-read-gate.spec.ts` | The semaphore's contract: ceiling, FIFO order, permit released on rejection |
| `tests/integration/turn-context-pool-fairness.spec.ts` | Two concurrent turns on the real pool: peak ≤ 6, peak = 6, fairness |
| `tests/integration/turn-context-scope-cardinality.spec.ts` | 501 entities on one profile: every name rendered, no UUID in the prompt |
| `tests/unit/scripts/turn-context-gate.spec.ts` | That the performance gate REJECTS: one injected value per acceptance criterion, each asserted to produce exit 1 |
| `tests/unit/scripts/turn-context-resolve-scope-medido.spec.ts` | That the gate MEASURES the `resolveScope` stage (#700): a real turn through the production `resolveScope`, counted by the harness's own per-turn instrument, red when the scope goes back to being fabricated in memory — and that the stage is inside the turn's CLOCK (`measureTurn` is the single place the turn's duration is computed; the spec pins the arithmetic with an injected clock and with a real one) |
| `scripts/turn-context-benchmark.ts` (`npm run turn:bench`) | Not a spec — the measurement itself. Real Postgres, 50 pairs, concurrency 20, cold/warm, `resolveScope` + `buildPrompt`. See the gate section above |
| `tests/unit/pending-gate.spec.ts` | Cada desfecho do `GateResult`, inclusive as três races (resolução, cancelamento, topic change) e o `stage` auditado |
| `tests/integration/pending-gate-concurrency.spec.ts` | Duas resoluções paralelas contra a MESMA pendência: exatamente um despacho e exatamente um `pending_race_lost`, lidos no banco (#545 / PR #562) |
| `tests/integration/pending-race-lost-terminal.spec.ts` | O DESTINO da perna perdedora: `runAgentForMensagem` real termina em `ignored`/`pending_race_lost`, sem ReAct e sem resposta |
| `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts` | O desfecho `cancelled` e os guards a jusante: perda de posse real (claim SQL → takeover → heartbeat → `AbortSignal`) no gate, no hook de scheduling, no grafo pre-turn (inclusive entre a decisão do selector e o `startExecution`) e no Decision Engine, provando ausência de mutação e de resposta em cada um — e QUAL limite recusou, via `maia_turn_effect_blocked_total{boundary}`. O DESFECHO do turno é lido em `agent_turns` + `agent_turn_inputs` (não em `processada_em`, que sob o regime autoritativo só existe em turno terminal): o CONTROLE exige que o DONO tenha fechado a tentativa, e cada barreira exige que a última gravação da linha seja a do SUCESSOR — `state_version` intacta desde o takeover |
| `tests/unit/prompt-injection.spec.ts` | Sanitization wraps user content in delimiters |
| `tests/unit/agent/` | Per-step contracts |
| `tests/integration/turn-flow.spec.ts` (if present) | End-to-end turn |

## In-flight changes

At last verification (2026-05-28):

- Skill execution via `runSkill` from decision engine (#216 — merged)
- AbortSignal plumbed from skill runner to LLM call (#221 — merged)
- Turn-context loader integrated + pure renderer (#525 — this change). Still
  open in #525: returning `capabilities`/`gaps` to the cache (decision to keep
  them out is recorded above). The ≤8 round-trip target is **closed by owner
  decision (2026-09-02)**: the goal was rewritten in terms of latency, the
  count stays as the O(1)-growth guardrail, and the absolute ceiling is a
  report line.
- Performance gate for #525 (`npm run turn:bench`, `scripts/turn-context-benchmark.ts`),
  corrected to the latency-first criteria above. Candidate PR #693 (fusing the
  two scope reads into one) is judged by this corrected gate: baseline and
  candidate in the same window, relative margins, O(1) count guardrail.
- PR #541 review follow-up: the shared read gate (finding 1) and the JOIN's
  entity-side cardinality (finding 2), both described above.

Verify: `gh pr list --state open --search "agent OR react OR turn"`.

---

| | |
|---|---|
| Last verified | 2026-08-24 |
| Against `main` HEAD | `c49c3855` |
