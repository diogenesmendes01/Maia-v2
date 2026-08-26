/**
 * Issue #535 §2 — reusable instrumentation wrappers.
 *
 * Two hot-path operations need a wrapper at the call site rather than a
 * scrape-time gauge: tool dispatch and turn-context load. Both live here rather
 * than at the call site itself so the privacy decisions (which labels, which
 * attributes) are reviewed in ONE file next to the taxonomy, and so the foreign
 * edit each needs is a single line.
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
import { METRIC, SPAN, type ContextLoadStage, type SpanStatus } from './taxonomy.js';
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
