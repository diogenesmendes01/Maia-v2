/**
 * Issue #535 §1 — operational span emission.
 *
 * `taxonomy.ts` has declared the span tree since #514; nothing produced a
 * span. This module is the producer. It is deliberately small and
 * dependency-free (see `otlp-exporter.ts` for why no `@opentelemetry/*`), and
 * it is built around four decisions:
 *
 * ## 1. The OTLP trace id IS the Maia trace id
 *
 * `correlation.ts` already derives a stable UUID per turn from the persisted
 * inbound row. A W3C trace id is 16 bytes; a UUID is 16 bytes. Stripping the
 * dashes converts one into the other losslessly, so a span exported to the
 * collector, a log line, an `audit_logs` row and a `runtime_trace_envelopes`
 * row all carry the SAME id — an operator pastes one value into all four
 * surfaces. Minting an independent OTLP id would have thrown that away.
 *
 * ## 2. Sampling is DERIVED, never random
 *
 * A turn crosses processes (ingress → BullMQ → worker). If each process rolled
 * its own dice we would export half-traces, which are worse than none: the
 * missing half reads as "that stage never ran". `shouldSampleTrace()` hashes
 * the trace id into a uniform [0,1) value, so every process independently
 * reaches the SAME verdict with no sampling bit to propagate and no payload
 * change. Same reason `deriveTraceId` is derived rather than minted.
 *
 * ## 3. The runtime parent is the ACTIVE span, not the declared parent
 *
 * `SPAN_PARENT` describes the target tree. Reality is partial: `tool.dispatch`
 * declares `react.iteration` as its parent, but `react.iteration` has no
 * instrumentation site yet, so at runtime its parent is whatever ancestor IS
 * open (`turn`). Attaching to the declared-but-absent parent would produce
 * spans pointing at ids that never existed. `isDeclaredAncestor()` keeps the
 * two honest: the runtime parent must be a real ANCESTOR in the declared tree,
 * so a genuinely wrong nesting still fails a test.
 *
 * ## 4. Fail-soft, always
 *
 * Every entry point is wrapped: a bug in span handling degrades into a missing
 * span, never a failed turn. The one exception is `MAIA_STRICT_METRIC_LABELS`,
 * which promotes an attribute-policy violation to a throw so the unit suite
 * catches a PII regression (same contract as `labels.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { tryGetCorrelation } from './correlation.js';
import { counter } from './metrics.js';
import {
  METRIC,
  SPAN_PARENT,
  type SpanName,
  type SpanStatus,
} from './taxonomy.js';
import {
  sanitizeSpanAttributes,
  type SpanAttributes,
  type SpanAttributeValue,
} from './span-attributes.js';

// ---------------------------------------------------------------------------
// W3C ids
// ---------------------------------------------------------------------------

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * UUID → 32-hex W3C trace id. Anything unparseable (or an all-zero id, which
 * the W3C spec declares invalid) falls back to a random one so the span is
 * still exportable — it just will not join the durable trace.
 */
export function traceIdToW3C(traceId: string | null | undefined): string {
  const hex = (traceId ?? '').replace(/-/g, '').toLowerCase();
  if (HEX32.test(hex) && !/^0+$/.test(hex)) return hex;
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Deterministic head sampling, consistent across processes.
 *
 * Hashing (rather than reading the trace id's own leading bytes) matters
 * because `deriveTraceId` returns `mensagens.id` VERBATIM when it is already a
 * UUID, and Postgres `gen_random_uuid()` bytes are not guaranteed to be
 * uniformly useful after we force the version/variant nibbles. One SHA-256
 * pass removes any structure and costs ~1µs.
 */
export function shouldSampleTrace(w3cTraceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const digest = createHash('sha256').update(w3cTraceId).digest();
  // 32 bits of entropy is plenty for a ratio and avoids BigInt.
  const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;
  return bucket < ratio;
}

// ---------------------------------------------------------------------------
// Span model
// ---------------------------------------------------------------------------

export interface EndedSpan {
  readonly name: SpanName;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly start_unix_nano: bigint;
  readonly end_unix_nano: bigint;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}

interface ActiveSpan {
  readonly name: SpanName;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly start_unix_nano: bigint;
}

const spanStorage = new AsyncLocalStorage<ActiveSpan>();

/** Sink for ended spans. Set by the exporter; `null` means "drop". */
type SpanSink = (span: EndedSpan) => void;
let sink: SpanSink | null = null;

export function setSpanSink(next: SpanSink | null): void {
  sink = next;
}

/** The span currently open on this async context, if any. */
export function currentSpan(): { name: SpanName; span_id: string; trace_id: string } | null {
  const s = spanStorage.getStore();
  return s ? { name: s.name, span_id: s.span_id, trace_id: s.trace_id } : null;
}

/**
 * Tracing is live only when a destination is configured AND a sink is wired.
 * With no endpoint the whole path short-circuits before any allocation — the
 * hot path is byte-for-byte the pre-#535 one, which is what makes shipping
 * this OFF by default safe.
 */
export function tracingEnabled(): boolean {
  return sink !== null && !!config.MAIA_OTLP_TRACES_ENDPOINT;
}

/**
 * Is `candidate` an ancestor of `name` in the DECLARED tree?
 *
 * Used by the test suite (and by strict mode) to catch instrumentation nested
 * under the wrong parent while still tolerating the intermediate spans that
 * have no emitter yet. See design note 3 in the header.
 */
export function isDeclaredAncestor(name: SpanName, candidate: SpanName): boolean {
  let cur: SpanName | null = SPAN_PARENT[name];
  let hops = 0;
  while (cur !== null && hops < 64) {
    if (cur === candidate) return true;
    cur = SPAN_PARENT[cur];
    hops++;
  }
  return false;
}

/**
 * Attribution + correlation attributes every span carries.
 *
 * `tenant_id`/`agent_id` come from ALS with the sanctioned `system` fallback
 * (AGENTS.md §4.1, same rule `observability/metrics.ts` follows). They are
 * read fail-SOFT: a missing tenant must not break a turn through the
 * observability path, and the security-critical readers still use the strict
 * getters.
 */
function ambientAttributes(): SpanAttributes {
  const out: SpanAttributes = {};
  try {
    const ctx = tryGetCurrentContext();
    out.tenant_id = ctx?.tenant_id ?? 'system';
    out.agent_id = ctx?.agent_id ?? 'system';
  } catch {
    out.tenant_id = 'system';
    out.agent_id = 'system';
  }
  const corr = tryGetCorrelation();
  if (corr) {
    out.trace_id = corr.trace_id;
    out.attempt = corr.attempt;
    out.attempt_id = corr.attempt_id;
    out.origin = corr.origin;
    if (corr.turn_id) out.turn_id = corr.turn_id;
  }
  return out;
}

function accountAttributeViolations(
  span: SpanName,
  violations: readonly { key: string; reason: string }[],
): void {
  for (const v of violations) {
    counter(METRIC.SPAN_ATTRIBUTE_REJECTED, { span, reason: v.reason });
  }
}

export interface WithSpanOptions {
  attributes?: SpanAttributes;
  /**
   * Explicit start instant (epoch ms). Used by spans that measure a window
   * that ALREADY closed before the process could observe it — `queue.wait` is
   * reconstructed from the persisted `enqueued_at_ms`, so its start predates
   * the worker entirely.
   */
  start_epoch_ms?: number;
  /** Classify a thrown error. Default: `error`. */
  statusOnError?: SpanStatus;
}

function msToUnixNano(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1_000_000n;
}

function emit(
  active: ActiveSpan,
  status: SpanStatus,
  attributes: SpanAttributes,
  endEpochMs: number,
): void {
  const target = sink;
  if (!target) return;
  const { attributes: safe, violations } = sanitizeSpanAttributes(active.name, {
    ...ambientAttributes(),
    ...attributes,
    status,
  });
  if (violations.length > 0) accountAttributeViolations(active.name, violations);
  target({
    name: active.name,
    trace_id: active.trace_id,
    span_id: active.span_id,
    parent_span_id: active.parent_span_id,
    start_unix_nano: active.start_unix_nano,
    end_unix_nano: msToUnixNano(endEpochMs),
    status,
    attributes: safe,
  });
}

/**
 * Run `fn` inside span `name`.
 *
 * Returns `fn`'s value untouched and rethrows its error untouched — the span
 * is pure observation, never a control-flow participant. When tracing is off
 * this is a single boolean check plus a direct call.
 */
export async function withSpan<T>(
  name: SpanName,
  fn: () => Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  if (!tracingEnabled()) return fn();

  let active: ActiveSpan;
  try {
    const parent = spanStorage.getStore() ?? null;
    const corr = tryGetCorrelation();
    const trace_id = parent?.trace_id ?? traceIdToW3C(corr?.trace_id);
    if (!shouldSampleTrace(trace_id, config.MAIA_OTLP_SAMPLE_RATIO)) {
      counter(METRIC.OTLP_SPANS_DROPPED, { reason: 'not_sampled' }, 1, {
        attribute: false,
      });
      return fn();
    }
    const startMs = options.start_epoch_ms ?? Date.now();
    active = {
      name,
      trace_id,
      span_id: newSpanId(),
      parent_span_id: parent?.span_id ?? null,
      start_unix_nano: msToUnixNano(startMs),
    };
  } catch (err) {
    // Span setup must never be the reason a turn dies.
    logger.debug({ err, span: name }, 'observability.span_setup_failed');
    return fn();
  }

  return spanStorage.run(active, async () => {
    try {
      const result = await fn();
      safely(() => emit(active, 'ok', options.attributes ?? {}, Date.now()));
      return result;
    } catch (err) {
      safely(() =>
        emit(
          active,
          options.statusOnError ?? 'error',
          options.attributes ?? {},
          Date.now(),
        ),
      );
      throw err;
    }
  });
}

/**
 * Record a span for a window that has already elapsed (no callback to wrap).
 *
 * `queue.wait` is the motivating case: by the time the worker can observe it,
 * the wait is over. Emitting it as a real span — rather than only a histogram
 * — is what makes the queue delay visible IN the waterfall next to the work it
 * delayed, which is the whole reason the issue asks for spans on top of the
 * metrics it already has.
 */
export function recordElapsedSpan(
  name: SpanName,
  startEpochMs: number,
  endEpochMs: number,
  attributes: SpanAttributes = {},
  status: SpanStatus = 'ok',
): void {
  if (!tracingEnabled()) return;
  safely(() => {
    const parent = spanStorage.getStore() ?? null;
    const corr = tryGetCorrelation();
    const trace_id = parent?.trace_id ?? traceIdToW3C(corr?.trace_id);
    if (!shouldSampleTrace(trace_id, config.MAIA_OTLP_SAMPLE_RATIO)) {
      counter(METRIC.OTLP_SPANS_DROPPED, { reason: 'not_sampled' }, 1, {
        attribute: false,
      });
      return;
    }
    const start = Math.min(startEpochMs, endEpochMs);
    emit(
      {
        name,
        trace_id,
        span_id: newSpanId(),
        parent_span_id: parent?.span_id ?? null,
        start_unix_nano: msToUnixNano(start),
      },
      status,
      attributes,
      endEpochMs,
    );
  });
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (config.MAIA_STRICT_METRIC_LABELS) throw err;
    logger.debug({ err }, 'observability.span_emit_failed');
  }
}

/** Test-only: drop any span left open by a failed spec. */
export function _resetTracerForTests(): void {
  sink = null;
}
