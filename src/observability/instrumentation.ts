/**
 * Issue #535 §2 — reusable instrumentation wrappers.
 *
 * A hot-path boundary needs a wrapper at the CALL SITE rather than a
 * scrape-time gauge — a gauge read at scrape time cannot say where in a turn
 * the time went. Every such wrapper lives here rather than at the call site
 * itself so the privacy and cardinality decisions of the whole span surface are
 * reviewed in ONE file next to the taxonomy, and so the foreign edit each needs
 * is a single line.
 *
 * The first two were tool dispatch and turn-context load; the turn-tree set
 * that closes #535's "declared but never emitted" gap is at the bottom of the
 * file, under its own header.
 *
 * They emit DIFFERENT things, and the asymmetry is the contract, not an
 * oversight:
 *   - `instrumentToolDispatch` owns its measurement end to end — a counter with
 *     a bounded outcome label (the rate/error SLI), a duration histogram (the
 *     latency SLI) and an OTLP span (the waterfall position);
 *   - `instrumentContextLoad` emits ONLY the span. The operation it wraps
 *     already publishes duration and round-trips through
 *     `src/agent/turn-context/metrics.ts` (`maia_turn_context_*`, issue #525),
 *     and a second family over the same window is drift with extra steps. See
 *     the wrapper's own comment.
 *
 * The span is what neither surface can replace: "the turn was slow" resolves to
 * "the turn was slow HERE" without a second deploy.
 *
 * The wrappers are transparent: the wrapped function's value is returned and
 * its error rethrown unchanged. Observability is never a control-flow
 * participant.
 */
import { counter, histogram } from './metrics.js';
import {
  METRIC,
  SPAN,
  type ContextLoadStage,
  type SpanName,
  type SpanStatus,
} from './taxonomy.js';
import { recordElapsedSpan, withSpan } from './tracer.js';
import type { SpanAttributes } from './span-attributes.js';
import {
  TOOL_FAILURE_CODES,
  TOOL_INVALID_CODES,
  TOOL_REFUSAL_CODES,
} from '@/tools/_dispatch-error-codes.js';
/**
 * TYPE-ONLY, and that direction is deliberate: `src/lib/llm/telemetry.ts`
 * imports this module at runtime, so a value import back would be an ESM
 * cycle. Erased at compile time, it costs nothing and buys the exhaustiveness
 * check on `SPAN_STATUS_BY_LLM_STATUS` — the producer owns the vocabulary and
 * observability imports it, exactly as `_dispatch-error-codes.ts` above.
 */
import type { LLMCallStatus } from '@/lib/llm/telemetry.js';

/**
 * Outcome vocabulary for a tool dispatch. Bounded and enumerated — a tool's
 * error STRING is unbounded free text and is forbidden as a label
 * (`taxonomy.ts` deny list), so the classifier collapses it to a class and the
 * detail stays in the log/trace.
 */
export type ToolDispatchOutcome = 'ok' | 'error' | 'blocked' | 'invalid';

/**
 * `{ error: <code> }` ⇒ outcome label, built from the CLOSED sets the
 * dispatcher and the MCP bridge export (`src/tools/_dispatch-error-codes.ts`).
 *
 * Built from their lists rather than restated here on purpose: the previous
 * hand-written `switch` knew five codes, four of which were real. It missed
 * `feature_disabled`, `tool_disabled` on the MCP path, `redis_unavailable_blocked`,
 * `approval_pending`, `requires_confirmation`, `requires_dual_approval` and
 * `mcp_tool_not_executable` — every one of them a fail-closed refusal that then
 * counted as an operational failure in `maia:tool_error_ratio:rate5m`. It also
 * mapped `approval_required`, which is a skill EXPOSURE policy
 * (`src/skills/usage-policy.ts:45`) that no dispatcher path can return: a
 * phantom entry is exactly the drift a copy produces.
 */
const OUTCOME_BY_CODE: ReadonlyMap<string, ToolDispatchOutcome> = new Map<
  string,
  ToolDispatchOutcome
>([
  ...TOOL_REFUSAL_CODES.map((c) => [c, 'blocked'] as const),
  ...TOOL_INVALID_CODES.map((c) => [c, 'invalid'] as const),
  ...TOOL_FAILURE_CODES.map((c) => [c, 'error'] as const),
]);

/**
 * Classify a dispatcher return value.
 *
 * `dispatchTool` signals failure by RETURNING `{ error: string }` rather than
 * throwing, so a naive wrapper would record every denied tool as a success.
 * The three failure classes are separated because they mean opposite things
 * operationally, and each has its own reader:
 *
 *   - `blocked` — governance refused. Rising means a mis-scoped grant, a killed
 *     flag or a queue of approvals waiting on humans. It is the platform
 *     WORKING, has its own SLI (`maia:tool_blocked_ratio:rate5m`) and is
 *     deliberately outside the error numerator.
 *   - `invalid` — the model produced args or a tool name the boundary rejected.
 *     Tracks model/prompt quality.
 *   - `error`   — the platform broke. This is what pages.
 *
 * The DEFAULT is `error`, and that stays deliberate: an `{ error }` shape from
 * a tool HANDLER (e.g. `cancel-transaction` returning `not_found`) is outside
 * the dispatcher's closed vocabulary, and counting an unrecognised failure as a
 * failure is the fail-safe direction. What must never happen again is a
 * DISPATCHER refusal reaching that default — which the closed sets plus
 * `tests/unit/observability/tool-error-codes.spec.ts` now prevent.
 */
export function classifyToolResult(result: unknown): ToolDispatchOutcome {
  if (typeof result !== 'object' || result === null) return 'ok';
  const err = (result as { error?: unknown }).error;
  if (typeof err !== 'string') return 'ok';
  return OUTCOME_BY_CODE.get(err) ?? 'error';
}

/**
 * Measure one tool dispatch.
 *
 * `tool` is the registry name — a closed set, budgeted at 200 distinct values
 * in `LABEL_CARDINALITY_BUDGET`, so a bug that passes user input as a tool name
 * degrades into `__overflow__` instead of unbounded series growth.
 */
export async function instrumentToolDispatch<T>(
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  let outcome: ToolDispatchOutcome = 'error';
  // The bag is read by `withSpan` when the span ENDS, so filling `result` in
  // once the outcome is known puts it on the exported span. Without it a
  // governance denial would render as a plain successful span (it returns
  // normally, so OTLP's status is `ok`) and the waterfall would disagree with
  // `maia_tool_dispatch_total` about the same dispatch.
  const attributes: SpanAttributes = { tool };
  try {
    return await withSpan(
      SPAN.TOOL_DISPATCH,
      async () => {
        const result = await fn();
        outcome = classifyToolResult(result);
        attributes.result = outcome;
        return result;
      },
      { attributes },
    );
  } finally {
    const duration = Date.now() - t0;
    counter(METRIC.TOOL_DISPATCH, { tool, result: outcome });
    histogram(METRIC.TOOL_DURATION_MS, duration, { tool, result: outcome });
  }
}

/**
 * Open the span `context.load` around one turn-context load.
 *
 * ## Span ONLY — deliberately no metric family
 *
 * This wrapper used to emit `maia_context_load_ms` + `maia_context_slices_total`
 * alongside the span, and the review of PR #554 retired both. The operation it
 * wraps is `loadTurnContext`, which issue #525 already measures:
 * `recordTurnContextLoad` (`src/agent/turn-context/metrics.ts`) publishes
 * `maia_turn_context_load_duration_ms{phase,result}` and
 * `maia_turn_context_db_queries{phase}` for the same work. Emitting a second
 * duration family over the same window would give an operator two numbers for
 * one question, which is worse than having one — they drift, and the alert and
 * the dashboard end up disagreeing about whether context load is slow.
 *
 * The span is not a duplicate of either: a histogram says HOW LONG, a span says
 * WHERE in the turn, and only the span puts the load next to the queue wait and
 * the LLM call in the same waterfall. That is the whole reason #535 asks for
 * spans on top of the metrics it already has.
 *
 * Failure is therefore recorded as the span's `status`, not as a `status`
 * LABEL — `withSpan` marks the span `error` and rethrows unchanged. The
 * failure RATE of the same operation is `maia_turn_context_load_duration_ms`'s
 * `result` label, published by the caller.
 *
 * ## `stage` is typed, not a string
 *
 * `ContextLoadStage`, not `string`: the review of PR #554 caught that calling
 * the set "closed" while the emitting surface accepted any string made the
 * closure a review convention instead of a contract. Cardinality control that
 * depends on nobody making a mistake is not control. Adding a member is a
 * deliberate edit to `CONTEXT_LOAD_STAGE` in the taxonomy.
 */
export async function instrumentContextLoad<T>(
  stage: ContextLoadStage,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(SPAN.CONTEXT_LOAD, fn, { attributes: { stage } });
}

/**
 * Record the span `llm.request` for one FINISHED LLM gateway call.
 *
 * ## Why this is `recordElapsedSpan` and not `withSpan`
 *
 * `executeLLM` (`src/lib/llm/gateway.ts`) has six terminal paths — missing
 * tenant context, missing API key, an open circuit, retry exhaustion, fallback
 * exhaustion, success — and each one is its own `return` or `throw`. Wrapping
 * its body would mean restructuring the one function on the critical path of
 * every turn in order to hang an observation off it, and a wrapper a seventh
 * exit can later bypass is a coverage claim with a hole in it.
 *
 * `emitUsage` already solved that problem for metrics: issue #508 collapsed
 * every outcome onto ONE emission point precisely because per-path emission
 * had left error, timeout, rate limit and cancellation counting nothing while
 * the runbook documented them. Binding the span to the same point makes "one
 * span per LLM request, on every outcome" structural — the span cannot drift
 * away from `maia_llm_requests_total`, because the same call emits both.
 *
 * The window is RECONSTRUCTED rather than measured live: `duration_ms` is the
 * gateway's own measurement and is what the histogram publishes, so the span
 * and `maia_llm_request_duration_ms` cannot disagree about how long the call
 * took. Same mechanism, and same reason, as `queue.wait`.
 *
 * ## Span ONLY — deliberately no metric family
 *
 * Same rule as `instrumentContextLoad`: `emitUsage` already publishes
 * `maia_llm_requests_total`, `maia_llm_request_duration_ms` and
 * `maia_llm_tokens_total` over this exact call. A second family measuring one
 * operation is the drift the taxonomy exists to prevent, and it is also the
 * only way this change could add cardinality — it does not. What the span adds
 * is POSITION: the model call next to the queue wait, the context load and the
 * tool dispatches of the same turn, in one waterfall.
 *
 * ## Status mapping
 *
 * `SpanStatus` has five members and `LLMCallStatus` seven, so two collapse —
 * along the line the runbook already draws between "the platform broke" and
 * "a control refused":
 *
 *   - `budget_exhausted` and `circuit_open` → `blocked`. WE refused: a quota
 *     ceiling, and the breaker. Rendering them `error` would put the
 *     protection working into the same bucket as the provider failing, which
 *     is the exact confusion `status="circuit_open"` was split out to prevent
 *     (#534). It is the same line `classifyToolResult` draws above.
 *   - `rate_limit` → `error`. THEY refused. The call did not happen and the
 *     turn ate it, which is a failure of the call however polite the 429 was.
 *
 * Nothing is lost: the verbatim seven-value vocabulary rides on the `result`
 * attribute. It cannot ride on `status` — `tracer.ts::emit` stamps the span's
 * own `SpanStatus` there last, and it wins on purpose so a span's `status`
 * attribute always equals its OTLP status code.
 *
 * The map is a TOTAL `Record`, so adding a member to `LLMCallStatus` without
 * deciding what it means for a trace fails `npm run typecheck`. That is the
 * closure; a review convention would not survive the next status.
 */
const SPAN_STATUS_BY_LLM_STATUS: Readonly<Record<LLMCallStatus, SpanStatus>> =
  Object.freeze({
    ok: 'ok',
    error: 'error',
    timeout: 'timeout',
    rate_limit: 'error',
    cancelled: 'cancelled',
    budget_exhausted: 'blocked',
    circuit_open: 'blocked',
  });

export interface LlmRequestSpanInput {
  /** The gateway's own measurement of the call, in ms. */
  duration_ms: number;
  status: LLMCallStatus;
  provider: string;
  model: string;
  tier: string;
  workload: string;
  /** Provider attempts this call consumed (`0` when it never reached one). */
  attempts: number;
  /** Instant the call was observed to have finished (epoch ms). */
  observed_at_ms: number;
}

export function recordLlmRequestSpan(input: LlmRequestSpanInput): void {
  const end = input.observed_at_ms;
  const duration = Number.isFinite(input.duration_ms)
    ? Math.max(0, input.duration_ms)
    : 0;
  recordElapsedSpan(
    SPAN.LLM_REQUEST,
    end - duration,
    end,
    {
      provider: input.provider,
      model: input.model,
      tier: input.tier,
      workload: input.workload,
      // The verbatim gateway vocabulary — see the status-mapping note above.
      result: input.status,
      // `attempt_count`, never `attempt`: `attempt` is the TURN's retry index
      // and `correlationAttributes()` stamps it on every span. Reusing the key
      // here would overwrite it and make a retried turn unjoinable in the
      // collector.
      attempt_count: input.attempts,
    },
    SPAN_STATUS_BY_LLM_STATUS[input.status],
  );
}

// ============================================================================
// Issue #535 — the turn-tree wrappers
// ============================================================================

/**
 * The rest of this file is the emitter set the owner's ruling on #535 asked
 * for: "um span que só existe na declaração é dívida, não observabilidade".
 * `taxonomy.ts` had eighteen names with nothing behind them; each of the ones
 * that survived that ruling gets a wrapper HERE, for the reason the header
 * already gives — the privacy and cardinality decisions of the whole span
 * surface stay reviewable in ONE file, and the edit each production call site
 * needs is a single line.
 *
 * ## Spans only. No new metric family, anywhere below
 *
 * Every wrapper added here emits a span and nothing else, and that is the same
 * decision `instrumentContextLoad` and `recordLlmRequestSpan` already argue
 * above, applied fifteen more times. Two consequences worth stating plainly,
 * because they are what makes this change cheap:
 *
 *   - **Cardinality is unchanged.** A span attribute lives on one exported
 *     span; it mints no time series (`taxonomy.ts` §4). Not one metric label is
 *     added by this change, so `LABEL_CARDINALITY_BUDGET` is untouched.
 *   - **Overhead is a boolean when tracing is off.** `withSpan` and
 *     `recordElapsedSpan` both check `tracingEnabled()` first and return
 *     immediately with no allocation. With `MAIA_OTLP_TRACES_ENDPOINT` unset —
 *     the default, and the state the whole unit suite runs in — the hot path is
 *     byte-for-byte the pre-#535 one.
 *
 * ## Every attribute value below is a CLOSED vocabulary, and typed as one
 *
 * The review of PR #554 caught `instrumentContextLoad` accepting `string` while
 * its comment called the set closed, and settled it: "cardinality control that
 * depends on nobody making a mistake is not control". So no wrapper here takes
 * a bare `string` for an outcome. Each takes the producer's own union type
 * (imported type-only, so nothing new is loaded at runtime), which means adding
 * a member to that union without deciding what it means for a trace is a
 * `npm run typecheck` failure rather than a silent new attribute value.
 */

/**
 * Run `fn` inside span `name`, and let the RESULT decide the span's attributes.
 *
 * The shape exists because the interesting attribute of a stage is almost
 * always its outcome, which is only known once the work is done — and
 * `withSpan` reads the bag when the span CLOSES, so filling it in from the
 * result is enough. Same trick `instrumentToolDispatch` uses for `result`.
 *
 * A throw still produces a span (status `error`, seed attributes only): the
 * failing stage is the one an operator most needs to see in the waterfall.
 * `describe` is never called on that path — there is no value to describe.
 */
async function withOutcomeSpan<T>(
  name: SpanName,
  fn: () => Promise<T>,
  describe: (value: T) => SpanAttributes,
  seed: SpanAttributes = {},
): Promise<T> {
  const attributes: SpanAttributes = { ...seed };
  return withSpan(
    name,
    async () => {
      const value = await fn();
      Object.assign(attributes, describe(value));
      return value;
    },
    { attributes },
  );
}

/**
 * The synchronous counterpart, for the gates that are pure CPU.
 *
 * `constitutionalCheck` and `canAct` are synchronous by design — they are pure
 * functions over the already-loaded pessoa/permission rows — so wrapping them
 * in `withSpan` would mean making them async, which changes the dispatcher's
 * control flow to hang an observation off it. `recordElapsedSpan` records the
 * window that just closed instead, which is the same mechanism `queue.wait` and
 * `llm.request` use and needs no restructuring.
 *
 * The cost of that choice, stated so nobody has to discover it: an elapsed span
 * does not open an ALS scope, so it cannot be the runtime PARENT of anything.
 * That is exactly right here — both gates are leaves in `SPAN_PARENT`.
 */
function recordSyncSpan<T>(
  name: SpanName,
  fn: () => T,
  describe: (value: T) => SpanAttributes,
  seed: SpanAttributes = {},
): T {
  const t0 = Date.now();
  try {
    const value = fn();
    recordElapsedSpan(name, t0, Date.now(), { ...seed, ...describe(value) }, 'ok');
    return value;
  } catch (err) {
    recordElapsedSpan(name, t0, Date.now(), seed, 'error');
    throw err;
  }
}

/**
 * `identity.resolve` — one span around `resolveIdentity`.
 *
 * Wrapped inside the resolver rather than at `agent/core.ts`'s call site
 * because the resolver has more than one production caller (the turn entry
 * point and the quarantine flows), and instrumenting the callers instead would
 * be the same copy-that-drifts the dispatcher error codes stopped being.
 *
 * `kind` is `ResolveResult['kind']` — four members, all governance outcomes.
 * The phone number the function takes is NEVER an attribute: it is on the span
 * deny list, and it is the single most sensitive value on this path.
 */
export function instrumentIdentityResolve<T extends { kind: string }>(
  fn: () => Promise<T>,
): Promise<T> {
  return withOutcomeSpan(SPAN.IDENTITY_RESOLVE, fn, (r) => ({ kind: r.kind }));
}

/** Bounded outcome of the per-turn audience resolution. */
export type AudienceResolveOutcome = 'resolved' | 'absent' | 'failed';

/**
 * `audience.resolve` — the audience-profile lookup plus `buildAudienceContext`.
 *
 * The span covers BOTH because only the pair is a boundary: the lookup is the
 * DB round trip, and `buildAudienceContext` is the pure derivation that decides
 * whether the turn ends up with an audience at all. Timing only the query would
 * hide the case the operator actually cares about — a turn running with
 * `audienceContext === null`, which silently skips two policy gates.
 *
 * `failed` is a real member and not an error status: the call site catches the
 * lookup error on purpose (a transient audience-store hiccup must not break the
 * turn), so from the span's point of view the stage completed — it just
 * completed without an audience, and that is what `result` says.
 */
export function instrumentAudienceResolve<T>(
  fn: () => Promise<T>,
  classify: (value: T) => AudienceResolveOutcome,
): Promise<T> {
  return withOutcomeSpan(SPAN.AUDIENCE_RESOLVE, fn, (v) => ({ result: classify(v) }));
}

/**
 * `preturn.graph` — the declarative pre-turn graph run.
 *
 * This is the span that makes `role.select` and `procedure.select` NEST rather
 * than float: both nodes run inside `runNodes`, so opening this one around the
 * call is what gives them the parent `SPAN_PARENT` declares. Without it they
 * would attach to `turn` and the waterfall would not show that the two run in
 * PARALLEL — which is the one thing about this stage an operator reading a slow
 * turn needs to know.
 *
 * `item_count` is the number of nodes mounted (today 1 or 2). Bounded by the
 * graph definition, never by input.
 */
export function instrumentPreturnGraph<T>(
  nodeCount: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withOutcomeSpan(SPAN.PRETURN_GRAPH, fn, () => ({}), { item_count: nodeCount });
}

/**
 * `procedure.select` — the procedure selector.
 *
 * `decision` is the selector's own five-member union
 * (`start|continue|switch|escalate|none`). The candidate procedure IDs are
 * deliberately NOT attributes: they are unbounded tenant data, and the decision
 * plus the trace id is what joins this span to the `procedure_selector_decisions`
 * row that holds the detail.
 */
export function instrumentProcedureSelect<T extends { decision: string }>(
  fn: () => Promise<T>,
): Promise<T> {
  return withOutcomeSpan(SPAN.PROCEDURE_SELECT, fn, (r) => ({ decision: r.decision }));
}

/**
 * `role.select` — the role selector.
 *
 * `action` is `RoleDecisionAction` (`keep_current|switch|handoff|fallback`).
 * The decided ROLE's id is not an attribute for the same reason the procedure
 * ids are not: it is tenant data with no ceiling, and `decision_id` on the
 * persisted row is the join.
 */
export function instrumentRoleSelect<T extends { action: string }>(
  fn: () => Promise<T>,
): Promise<T> {
  return withOutcomeSpan(SPAN.ROLE_SELECT, fn, (r) => ({ action: r.action }));
}

/**
 * `decision.evaluate` — one span per Decision Engine run.
 *
 * Wrapped around `DecisionEngine.decide` itself, not around
 * `runDecisionEngineForTurn` in the integration shim. Both are production
 * entry points into the same engine, and the shim is the one that varies
 * (`runDecisionEngineIfEnabled` exists beside it for callers that wire their
 * own deps); binding the span to the engine means every route into it is
 * covered, which is the same argument that put `llm.request` on `emitUsage`
 * instead of on `executeLLM`'s six exits.
 *
 * It is also what gives `risk.classify` a parent: the risk step runs inside
 * `decide`, so the ALS scope opened here is already active when step 3 fires.
 *
 * `decision` is the resulting `action_mode`; a PEP block short-circuits before
 * one exists, and those paths report the minimal packet's mode, so the
 * attribute is total.
 */
export function instrumentDecisionEvaluate<T>(
  fn: () => Promise<T>,
  classify: (value: T) => { decision: string; blocked: boolean },
): Promise<T> {
  return withOutcomeSpan(SPAN.DECISION_EVALUATE, fn, (v) => {
    const { decision, blocked } = classify(v);
    return { decision, result: blocked ? 'blocked' : 'ok' };
  });
}

/**
 * `risk.classify` — step 3 of the Decision Engine.
 *
 * `severity` is `RiskLevel` (`low|medium|high`) and `required` is the
 * human-review flag. The risk REASONS are not attributes: they are free text
 * assembled by the scorer, which is precisely the shape the span deny list
 * exists to keep off a third-party collector.
 */
export function instrumentRiskClassify<
  T extends { level: string; requires_human_review: boolean },
>(fn: () => Promise<T>): Promise<T> {
  return withOutcomeSpan(SPAN.RISK_CLASSIFY, fn, (r) => ({
    severity: r.level,
    required: r.requires_human_review,
  }));
}

/**
 * `prompt.render` — the whole prompt assembly, `buildPrompt`.
 *
 * This is also the span that finally gives `context.load` a real parent:
 * `buildPrompt` calls `loadTurnContext`, so `SPAN_PARENT[CONTEXT_LOAD]` was
 * corrected from `turn` to `prompt.render` in the same change. The pair is the
 * most useful thing in the waterfall for a slow turn — it separates "we spent
 * the time READING state" from "we spent it ASSEMBLING the prompt".
 *
 * `item_count` is the number of messages in the rendered conversation. Bounded
 * by the history window, and a number, so it cannot carry content.
 */
export function instrumentPromptRender<T extends { messages: readonly unknown[] }>(
  fn: () => Promise<T>,
): Promise<T> {
  return withOutcomeSpan(SPAN.PROMPT_RENDER, fn, (r) => ({
    item_count: r.messages.length,
  }));
}

/**
 * `react.iteration` — one span per iteration of the ReAct loop.
 *
 * The span that mattered most to open, because it is the declared PARENT of
 * `llm.request` and `tool.dispatch` — the two spans that were already emitted
 * and, until now, both attached to `turn`. A turn with three iterations and
 * five tool calls rendered as one flat row of eight siblings, with nothing
 * saying which model call led to which tools. With this span they nest, and
 * "the second round-trip is the slow one" becomes readable off the waterfall
 * instead of inferable from timestamps.
 *
 * `attempt_count` is the 1-based iteration index, hard-bounded by
 * `MAX_REACT_ITERATIONS`. It is `attempt_count` and never `attempt`: `attempt`
 * is the TURN's retry index, stamped on every span by `correlationAttributes()`
 * — the same collision `recordLlmRequestSpan` avoids for the same reason.
 */
export function instrumentReactIteration<T>(
  iteration: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(SPAN.REACT_ITERATION, fn, {
    attributes: { attempt_count: iteration },
  });
}

/** Bounded outcome of the constitutional gate. */
export type ConstitutionalOutcome = 'ok' | 'forbidden' | 'requires_approval';

/**
 * `constitutional.check` — the hard-rule gate, first of the four inside
 * `dispatchToolInner`.
 *
 * Synchronous (see `recordSyncSpan`). `result` separates the three things a
 * violation can mean, and the split is the same one `classifyToolResult` draws
 * higher up this file: `forbidden` is a refusal that ends the dispatch,
 * `requires_approval` is a violation that becomes an approval REQUIREMENT
 * resolved further down, and collapsing them would make a working
 * dual-approval flow look like a governance denial.
 *
 * The violated `rule_id` is not an attribute. It is a tenant-authored
 * identifier with no ceiling; the audit row carries it.
 */
export function instrumentConstitutionalCheck<T>(
  tool: string,
  fn: () => T,
  classify: (value: T) => ConstitutionalOutcome,
): T {
  return recordSyncSpan(
    SPAN.CONSTITUTIONAL_CHECK,
    fn,
    (v) => ({ result: classify(v) }),
    { tool },
  );
}

/**
 * `permission.check` — the `canAct` loop, second gate.
 *
 * ONE span for the whole loop, not one per `required_actions` entry: the loop
 * is a conjunction (any denial ends the dispatch), so N spans would render N-1
 * identical `allowed` rows and one `denied` for what is a single decision.
 * `item_count` keeps the number of actions checked, which is the only part of
 * the loop shape worth carrying.
 *
 * The DENIAL REASON is not an attribute: `canAct` returns free-form
 * `reason` strings and the span deny list forbids raw error text. The audit row
 * (`unauthorized_access_attempt`) already carries it, joined by trace id.
 */
export function instrumentPermissionCheck<T>(
  tool: string,
  actionCount: number,
  fn: () => T,
  classify: (value: T) => 'allowed' | 'denied',
): T {
  return recordSyncSpan(
    SPAN.PERMISSION_CHECK,
    fn,
    (v) => ({ result: classify(v) }),
    { tool, item_count: actionCount },
  );
}

/**
 * `idempotency.claim` — the atomic reservation, third gate.
 *
 * The span covers `tryReserve` alone, which is the one INSERT … ON CONFLICT
 * that decides whether THIS caller executes the handler. `state` is the
 * reservation's own closed vocabulary (`reserved|completed|failed|in_progress|
 * collision`), and it is the attribute that explains an idle turn: a span
 * showing `in_progress` is a caller waiting on another worker's reservation,
 * which reads nothing like a slow database until you can see it.
 *
 * The idempotency KEY is not an attribute — it is a hash over the payload, so
 * it is both unbounded and derived from content.
 */
export function instrumentIdempotencyClaim<T>(
  tool: string,
  fn: () => Promise<T>,
  classify: (value: T) => string,
): Promise<T> {
  return withOutcomeSpan(SPAN.IDEMPOTENCY_CLAIM, fn, (v) => ({ state: classify(v) }), {
    tool,
  });
}

/**
 * `handler.execute` — the tool handler itself, fourth gate and the only line in
 * `dispatchToolInner` that produces an effect.
 *
 * Separating it from the enclosing `tool.dispatch` is the whole point: the
 * parent measures the dispatch INCLUDING every gate, the approval round trip
 * and the reservation wait, and those routinely dominate. Without this span,
 * "the tool is slow" cannot be told apart from "the tool waited", and they have
 * opposite fixes.
 *
 * A throw is left to the span's own `error` status — `withSpan` rethrows
 * unchanged, so the dispatcher's `catch` (which marks the reservation failed and
 * fails the approval evidence) is entered exactly as before.
 */
export function instrumentHandlerExecute<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(SPAN.HANDLER_EXECUTE, fn, { attributes: { tool } });
}

/**
 * `outbound.commit` — the transactional commit of a reply intent.
 *
 * The boundary that survived the outbox migration: since #316/#630 the physical
 * send happens in the delivery worker, minutes and a process away, so the span
 * that belongs to the TURN is this one — the transaction that makes the reply
 * durable and, by #631, the thing that must succeed before anything reaches the
 * channel. That is also why `whatsapp.send` was removed rather than wired; see
 * `SPANS_REMOVED_IN_535`.
 *
 * `result` is `committed` or the skip's own named reason (`no_turn_scope` |
 * `turn_state_machine_off` | `feature_disabled`) — a closed set of four, and the
 * distinction the skip type exists to preserve.
 */
export function instrumentOutboundCommit<T>(
  fn: () => Promise<T>,
  classify: (value: T) => string,
): Promise<T> {
  return withOutcomeSpan(SPAN.OUTBOUND_COMMIT, fn, (v) => ({ result: classify(v) }));
}

/**
 * `turn.complete` — the terminal transition, `concludeTurn`.
 *
 * One site covers every ending because `concludeTurn` IS the single terminal
 * transition: `agent/core.ts` reaches it from roughly twenty places (identity
 * unknown, rate limited, blocked by policy, reply delivered …) and each passes
 * its own `TurnOutcome`. Instrumenting the callers would have been twenty edits
 * and a permanent invitation to forget the twenty-first.
 *
 * `outcome` is `TurnOutcome`: sixteen members, frozen in
 * `src/runtime/turns/contract.ts`, which is what makes it safe as an attribute.
 * The span is what closes the waterfall — a trace whose last row is
 * `turn.complete{outcome="reply_delivered"}` is a turn that ended on purpose,
 * and one without it is a turn that died somewhere above.
 */
export function instrumentTurnComplete<T>(outcome: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(SPAN.TURN_COMPLETE, fn, { attributes: { outcome } });
}
