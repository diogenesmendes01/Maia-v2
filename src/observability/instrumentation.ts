/**
 * Issue #535 §2 — reusable instrumentation wrappers.
 *
 * Two of the five missing metric families are per-call, not scrape-time, so
 * they need a wrapper at the call site rather than a gauge: tool dispatch and
 * turn-context load. Both live here rather than at the call site itself so the
 * privacy decisions (which labels, which attributes) are reviewed in ONE file
 * next to the taxonomy, and so the foreign edit each needs is a single line.
 *
 * Each wrapper emits three things from one measurement:
 *   - a counter with a bounded outcome label — the rate/error SLI;
 *   - a duration histogram — the latency SLI;
 *   - an OTLP span — the waterfall position, so "the turn was slow" resolves to
 *     "the turn was slow HERE" without a second deploy.
 *
 * The wrappers are transparent: the wrapped function's value is returned and
 * its error rethrown unchanged. Observability is never a control-flow
 * participant.
 */
import { counter, histogram } from './metrics.js';
import { METRIC, SPAN, type ContextLoadStage } from './taxonomy.js';
import { withSpan } from './tracer.js';
import type { SpanAttributes } from './span-attributes.js';
import {
  TOOL_FAILURE_CODES,
  TOOL_INVALID_CODES,
  TOOL_REFUSAL_CODES,
} from '@/tools/_dispatch-error-codes.js';

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
 * Measure one turn-context load.
 *
 * `stage` is typed as `ContextLoadStage`, not `string`, and that is the whole
 * point: the review of PR #554 caught that calling the set "closed" while the
 * emitting surface accepted any string made the closure a review convention
 * instead of a contract. Cardinality control that depends on nobody making a
 * mistake is not control.
 *
 * Today the set is `['packet']` — the P8a assembly. The per-slice stages this
 * comment used to promise (`working_memory`, `episodic`, `profile`, …) had no
 * emitter, so they are not in the vocabulary; adding one is a deliberate edit
 * to `CONTEXT_LOAD_STAGE` in the taxonomy, which is exactly the friction that
 * keeps a metric label bounded.
 */
export async function instrumentContextLoad<T>(
  stage: ContextLoadStage,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  let status: 'ok' | 'error' = 'ok';
  try {
    return await withSpan(SPAN.CONTEXT_LOAD, fn, { attributes: { stage } });
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    histogram(METRIC.CONTEXT_LOAD_MS, Date.now() - t0, { stage, status });
    counter(METRIC.CONTEXT_SLICES, { stage, status });
  }
}
