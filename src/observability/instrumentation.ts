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
import { METRIC, SPAN } from './taxonomy.js';
import { withSpan } from './tracer.js';
import type { SpanAttributes } from './span-attributes.js';

/**
 * Outcome vocabulary for a tool dispatch. Bounded and enumerated — a tool's
 * error STRING is unbounded free text and is forbidden as a label
 * (`taxonomy.ts` deny list), so the classifier collapses it to a class and the
 * detail stays in the log/trace.
 */
export type ToolDispatchOutcome = 'ok' | 'error' | 'blocked' | 'invalid';

/**
 * Classify a dispatcher return value.
 *
 * `dispatchTool` signals failure by RETURNING `{ error: string }` rather than
 * throwing, so a naive wrapper would record every denied tool as a success.
 * The governance verdicts are separated from ordinary failures because they
 * mean opposite things operationally: `blocked` rising is the platform
 * correctly refusing (possibly a mis-scoped grant), `error` rising is the
 * platform breaking.
 */
export function classifyToolResult(result: unknown): ToolDispatchOutcome {
  if (typeof result !== 'object' || result === null) return 'ok';
  const err = (result as { error?: unknown }).error;
  if (typeof err !== 'string') return 'ok';
  switch (err) {
    case 'forbidden':
    case 'tool_not_granted':
    case 'tool_disabled':
    case 'no_entity_in_scope':
    case 'approval_required':
      return 'blocked';
    case 'invalid_args':
      return 'invalid';
    default:
      return 'error';
  }
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
 * `stage` names the slice being assembled (`working_memory`, `episodic`,
 * `profile`, …) or `packet` for the whole assembly. Bounded by the slice
 * registry, budgeted at 60 distinct values.
 */
export async function instrumentContextLoad<T>(
  stage: string,
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
