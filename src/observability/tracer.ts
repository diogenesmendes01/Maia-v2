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
 * ## 4. Attribution is RESOLVED, not read at close
 *
 * The root `turn` span opens BEFORE the tenant is known: the worker wraps the
 * processor in the sanctioned `system` context and `agent/core.ts` opens the
 * real `runWithTenantContext` NESTED inside it. That nested scope is already
 * unwound by the time the root's `emit()` runs after its `await`, so reading
 * ALS at close returned `system` for every root span ever exported — a
 * waterfall whose root could not be filtered by tenant, and whose children
 * (opened inside the real scope) disagreed with it.
 *
 * So attribution is CAPTURED instead of read: entering a tenant scope
 * publishes the tuple onto every span open on that async context
 * (`publishSpanAttribution`, wired through `setTenantScopeObserver`), and
 * `emit()` uses the captured tuple. Two properties make this safe under
 * concurrency, and both are pinned by tests:
 *
 *   - the slot lives on the per-span object created inside `spanStorage.run`,
 *     so two jobs processing different tenants write to different objects —
 *     there is no shared mutable state to race on;
 *   - the slot is WRITE-ONCE with the first REAL (non-`system`) tuple. A
 *     `system` scope never downgrades a resolved span, and a second, different
 *     tenant never re-stamps one — it is counted as
 *     `maia_span_attribute_rejected_total{reason="attribution_conflict"}` and
 *     ignored, because a span carrying another tenant's tuple is the isolation
 *     failure this whole mechanism exists to prevent.
 *
 * ## 5. Fail-soft, always
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
import { setTenantScopeObserver, tryGetCurrentContext } from '@/db/tenant-context.js';
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
  /**
   * The ancestor span object still OPEN on this async context (`null` for the
   * root). `parent_span_id` alone is an id, not a handle — attribution has to
   * be able to walk up and stamp the ancestors that opened before the tenant
   * was known.
   */
  readonly parent: ActiveSpan | null;
  readonly start_unix_nano: bigint;
  /**
   * The tenant tuple resolved INSIDE this span. Deliberately mutable and
   * deliberately write-once — see design note 4 in the header. `null` means
   * "nothing resolved yet"; `emit()` then falls back to the ambient read and
   * finally to the sanctioned `system` sentinel.
   */
  attribution: SpanAttribution | null;
}

const spanStorage = new AsyncLocalStorage<ActiveSpan>();

/** Sink for ended spans. Set by the exporter; `null` means "drop". */
type SpanSink = (span: EndedSpan) => void;
let sink: SpanSink | null = null;

export function setSpanSink(next: SpanSink | null): void {
  sink = next;
  // Attribution capture is only meaningful once a destination exists — with
  // no sink `tracingEnabled()` is false and every span path short-circuits.
  // Installing the observer HERE rather than at import time keeps this module
  // from making a load-time demand on `db/tenant-context.js`, which a large
  // number of specs partially mock.
  if (next !== null) installTenantScopeObserver();
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

/** The `tenant_id + agent_id` tuple a span is attributed to. */
export interface SpanAttribution {
  readonly tenant_id: string;
  readonly agent_id: string;
}

/**
 * Sanctioned fallback for genuinely tenant-less work (AGENTS.md §4.1, same
 * rule `observability/metrics.ts` and `governance/audit.ts` follow). It is a
 * LAST resort here, not the default it used to be in practice.
 */
const SYSTEM_ATTRIBUTION: SpanAttribution = Object.freeze({
  tenant_id: 'system',
  agent_id: 'system',
});

function isSystemAttribution(a: SpanAttribution): boolean {
  return (
    a.tenant_id === SYSTEM_ATTRIBUTION.tenant_id &&
    a.agent_id === SYSTEM_ATTRIBUTION.agent_id
  );
}

function sameAttribution(a: SpanAttribution, b: SpanAttribution): boolean {
  return a.tenant_id === b.tenant_id && a.agent_id === b.agent_id;
}

/**
 * Read the tenant tuple from ALS, fail-SOFT.
 *
 * `null` (rather than the `system` sentinel) when there is no usable context,
 * so callers can tell "no tenant known here" from "this really is system
 * work" — the two used to collapse, which is what let a root span claim
 * `system` attribution it had never actually been told.
 */
function readAmbientAttribution(): SpanAttribution | null {
  try {
    const ctx = tryGetCurrentContext();
    if (!ctx) return null;
    return { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id };
  } catch {
    return null;
  }
}

/**
 * Publish a resolved tenant tuple onto every span OPEN on this async context.
 *
 * This is the mechanism that makes the root honest. The root `turn` span is
 * opened outside the tenant scope and closed after it has unwound, so it can
 * only learn its tenant from INSIDE — the moment `runWithTenantContext` opens
 * (see `installTenantScopeObserver` at the bottom of this file), or the moment
 * a nested span is opened under a resolved scope.
 *
 * The two rules that keep the isolation invariant intact:
 *
 *   1. `system` never publishes. The worker's outer `runWithSystemContext`
 *      must not overwrite a tenant the turn already resolved, in either order.
 *   2. A span's tuple is WRITE-ONCE. A second, DIFFERENT real tenant seen
 *      under the same span is an anomaly, not an update: re-stamping would put
 *      one tenant's tuple on another tenant's span, which is precisely the
 *      leak the invariant forbids. It is counted and dropped instead.
 *
 * Concurrency safety is structural, not defensive: the slots live on the
 * per-span objects created inside `spanStorage.run`, so two jobs running
 * different tenants never touch the same object.
 */
export function publishSpanAttribution(
  attribution: SpanAttribution | null | undefined,
): void {
  if (!attribution) return;
  if (isSystemAttribution(attribution)) return;
  for (let span = spanStorage.getStore() ?? null; span !== null; span = span.parent) {
    if (span.attribution === null) {
      span.attribution = attribution;
      continue;
    }
    if (sameAttribution(span.attribution, attribution)) continue;
    counter(
      METRIC.SPAN_ATTRIBUTE_REJECTED,
      { span: span.name, reason: 'attribution_conflict' },
      1,
      // Self-metric about attribution: attributing IT from the same ALS would
      // be circular, and the offending tuple is the payload, not the label.
      { attribute: false },
    );
  }
}

/** The tuple a span will be exported with. */
function resolveAttribution(active: ActiveSpan): SpanAttribution {
  return active.attribution ?? readAmbientAttribution() ?? SYSTEM_ATTRIBUTION;
}

/**
 * Correlation attributes every span carries. Read fail-SOFT: a missing
 * correlation must not break a turn through the observability path.
 */
function correlationAttributes(): SpanAttributes {
  const out: SpanAttributes = {};
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
  /**
   * Called once at close with the tuple the span was ultimately attributed to.
   *
   * Exists for the spans that are emitted OUTSIDE the turn's call stack and
   * therefore cannot read the resolution themselves: `queue.wait` reconstructs
   * a window that closed before the worker existed, so the only way it can be
   * attributed is to be handed the tuple the root resolved to (see
   * `src/gateway/queue.ts`). Fail-soft: a throwing callback cannot break the
   * turn.
   */
  onAttribution?: (attribution: SpanAttribution) => void;
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
  // Attribution comes from the CAPTURED tuple, not from an ALS read at this
  // instant: for the root span the tenant scope has already unwound by now
  // (design note 4). Caller-supplied attributes still win over both, which is
  // how `queue.wait` carries a tuple resolved after it was reconstructed.
  const attribution = resolveAttribution(active);
  const { attributes: safe, violations } = sanitizeSpanAttributes(active.name, {
    tenant_id: attribution.tenant_id,
    agent_id: attribution.agent_id,
    ...correlationAttributes(),
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
      parent,
      start_unix_nano: msToUnixNano(startMs),
      attribution: null,
    };
  } catch (err) {
    // Span setup must never be the reason a turn dies.
    logger.debug({ err, span: name }, 'observability.span_setup_failed');
    return fn();
  }

  return spanStorage.run(active, async () => {
    // A span opened INSIDE a resolved scope knows its tenant immediately, and
    // publishing it upward is what lets an ancestor that opened before the
    // resolution (the root `turn`) inherit it even with no scope observer.
    safely(() => publishSpanAttribution(readAmbientAttribution()));
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
    } finally {
      // Reported on BOTH paths: a turn that threw still belongs to a tenant,
      // and its `queue.wait` sibling must not silently fall back to `system`.
      const reported = resolveAttribution(active);
      safely(() => options.onAttribution?.(reported));
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
    // Synchronous, so the ambient read IS accurate here — and worth
    // publishing: an elapsed span recorded inside a resolved scope attributes
    // the ancestors that opened before it.
    const ambient = readAmbientAttribution();
    publishSpanAttribution(ambient);
    emit(
      {
        name,
        trace_id,
        span_id: newSpanId(),
        parent_span_id: parent?.span_id ?? null,
        parent,
        start_unix_nano: msToUnixNano(start),
        attribution: ambient,
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

let scopeObserverInstalled = false;

/**
 * Wire the tenant-scope notification to attribution capture.
 *
 * Dependency-INVERTED on purpose: `db/tenant-context.ts` is the fail-closed
 * security boundary and must not import the observability stack, so it exposes
 * a registration point and this module fills it.
 *
 * Idempotent, and fail-soft like every other entry point here: a process that
 * cannot install the observer loses span attribution, never a tenant scope.
 *
 * Cost once installed and tracing is off: one boolean check
 * (`tracingEnabled()`) per tenant scope, before any allocation — the hot-path
 * claim in the header stands.
 */
function installTenantScopeObserver(): void {
  if (scopeObserverInstalled) return;
  try {
    setTenantScopeObserver((ctx) => {
      if (!tracingEnabled()) return;
      publishSpanAttribution({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
    });
    scopeObserverInstalled = true;
  } catch (err) {
    logger.debug({ err }, 'observability.tenant_scope_observer_unavailable');
  }
}

/** Test-only: drop any span left open by a failed spec. */
export function _resetTracerForTests(): void {
  sink = null;
}
