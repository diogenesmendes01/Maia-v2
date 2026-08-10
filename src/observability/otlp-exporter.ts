/**
 * Issue #535 §1 — OTLP/HTTP exporter, dependency-free.
 *
 * ## Why no `@opentelemetry/*`
 *
 * OTLP is a wire format, not a framework. The HTTP/JSON binding
 * (`opentelemetry-proto`, `ExportTraceServiceRequest` encoded as canonical
 * protobuf-JSON) is a POST of a plain object to `/v1/traces`, and every
 * collector — the OpenTelemetry Collector, Jaeger, Tempo, Honeycomb, Datadog's
 * OTLP intake — accepts it. Pulling the SDK would add a dependency tree an
 * order of magnitude larger than this file, own the process's global tracer,
 * and monkey-patch `http`/`pg`/`ioredis` on import — a hot-path behaviour
 * change we cannot justify to ship a span. `fetch` is built into Node 22
 * (`AGENTS.md` §2 pins the runtime), so there is nothing to install.
 *
 * The cost of that choice, stated plainly: no automatic instrumentation, no
 * context propagation over outbound HTTP, no protobuf binding. All three are
 * out of scope for this issue and none is needed for the turn waterfall.
 *
 * ## Delivery posture
 *
 * Batched, bounded and lossy BY DESIGN, in that order:
 *
 *   - bounded queue: a collector outage must not turn into a heap incident in
 *     the process it was supposed to be observing. Past `maxQueueSize` the
 *     NEWEST span is dropped and counted;
 *   - counted loss: `maia_otlp_spans_dropped_total{reason}` distinguishes
 *     "not sampled" from "collector down" from "batch rejected". An exporter
 *     that loses spans silently produces gaps that read as "nothing happened";
 *   - never throws, never retries forever: one attempt per batch with an
 *     `AbortSignal` deadline. Retrying an OTLP batch reorders nothing and
 *     duplicates spans, and the collector is not the system of record — the
 *     durable HMAC trace is (`control-plane/runtime-trace/`).
 *
 * ## Privacy
 *
 * Attributes are sanitized by `span-attributes.ts` at SPAN END, before a span
 * enters this queue — so an unsanitized span never exists in memory waiting to
 * be flushed. This module adds one further guarantee: the resource attributes
 * it stamps are static, operator-supplied identity (`service.name`), never
 * anything read from a turn.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { counter, gauge, histogram } from './metrics.js';
import { METRIC } from './taxonomy.js';
import { setSpanSink, type EndedSpan } from './tracer.js';
import type { SpanAttributeValue } from './span-attributes.js';

// ---------------------------------------------------------------------------
// Tunables. Deliberately constants and not env vars: they are memory-safety
// bounds, not policy, and every extra knob is another way to misconfigure the
// thing that is supposed to be diagnosing the outage.
// ---------------------------------------------------------------------------

const MAX_QUEUE_SIZE = 2048;
const MAX_BATCH_SIZE = 256;
const SCHEDULED_DELAY_MS = 5_000;
const EXPORT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// OTLP/JSON encoding (opentelemetry-proto v1, protobuf-JSON mapping)
// ---------------------------------------------------------------------------

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/**
 * `intValue` is a STRING in protobuf-JSON (int64 exceeds IEEE-754 exact range,
 * so the mapping mandates string encoding). Collectors reject a numeric
 * `intValue` — this is the single most common hand-rolled-OTLP bug.
 */
function toAnyValue(v: SpanAttributeValue): OtlpAnyValue {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

function toKeyValues(attrs: Readonly<Record<string, SpanAttributeValue>>): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

/**
 * OTLP status codes: 0 UNSET, 1 OK, 2 ERROR. Maia's richer vocabulary
 * (`blocked`, `timeout`, `cancelled`) collapses onto ERROR for the code and is
 * preserved verbatim in the `status` attribute, so nothing is lost — a
 * governance BLOCK stays distinguishable from a provider timeout in the
 * collector's query language.
 */
function toStatusCode(status: EndedSpan['status']): 0 | 1 | 2 {
  return status === 'ok' ? 1 : 2;
}

export function encodeSpans(
  spans: readonly EndedSpan[],
  serviceName: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'maia-observability' } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'maia.observability', version: '1' },
            spans: spans.map((s) => ({
              traceId: s.trace_id,
              spanId: s.span_id,
              ...(s.parent_span_id ? { parentSpanId: s.parent_span_id } : {}),
              name: s.name,
              // SPAN_KIND_INTERNAL(1): these are in-process stages, not RPC
              // boundaries. Claiming SERVER/CLIENT would make collectors
              // compute bogus service-graph edges.
              kind: 1,
              startTimeUnixNano: s.start_unix_nano.toString(),
              endTimeUnixNano: s.end_unix_nano.toString(),
              attributes: toKeyValues(s.attributes),
              status: { code: toStatusCode(s.status) },
            })),
          },
        ],
      },
    ],
  };
}

/** Parse `k=v,k=v` into headers. Malformed pairs are skipped, never thrown. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface OtlpTransportResult {
  ok: boolean;
  /** HTTP status when the request completed, `0` for a transport failure. */
  status: number;
}

export type OtlpTransport = (
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
) => Promise<OtlpTransportResult>;

/**
 * Default transport. Reads nothing from the response body on purpose: a
 * collector's error payload can echo request content back, and logging it
 * would re-introduce through the error path exactly what the attribute gate
 * removed from the happy path.
 */
export const fetchTransport: OtlpTransport = async (endpoint, headers, body, signal) => {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
};

// ---------------------------------------------------------------------------
// Batching exporter
// ---------------------------------------------------------------------------

export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  transport?: OtlpTransport;
  maxQueueSize?: number;
  maxBatchSize?: number;
  scheduledDelayMs?: number;
  exportTimeoutMs?: number;
}

export class OtlpSpanExporter {
  private readonly queue: EndedSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly transport: OtlpTransport;
  private readonly maxQueueSize: number;
  private readonly maxBatchSize: number;
  private readonly scheduledDelayMs: number;
  private readonly exportTimeoutMs: number;

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.serviceName = options.serviceName ?? 'maia-runtime';
    this.transport = options.transport ?? fetchTransport;
    this.maxQueueSize = options.maxQueueSize ?? MAX_QUEUE_SIZE;
    this.maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
    this.scheduledDelayMs = options.scheduledDelayMs ?? SCHEDULED_DELAY_MS;
    this.exportTimeoutMs = options.exportTimeoutMs ?? EXPORT_TIMEOUT_MS;
  }

  /**
   * Accept an ended span. Synchronous, allocation-free past the push, and it
   * NEVER awaits — this runs on the turn's call stack.
   */
  enqueue = (span: EndedSpan): void => {
    if (this.stopped) {
      counter(METRIC.OTLP_SPANS_DROPPED, { reason: 'shutdown' }, 1, { attribute: false });
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      // Drop the NEW span rather than shifting the old one out: shift() on a
      // 2048-entry array runs on the turn's stack, and during a collector
      // outage that is every single span. The already-queued spans are also
      // the older, more complete traces.
      counter(METRIC.OTLP_SPANS_DROPPED, { reason: 'queue_full' }, 1, { attribute: false });
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.maxBatchSize) void this.flush();
  };

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.scheduledDelayMs);
    // Never keep the process alive for a telemetry flush.
    this.timer.unref?.();
    gauge(METRIC.OTLP_QUEUE_DEPTH, () => this.queue.length);
  }

  /**
   * Send everything queued, one batch at a time.
   *
   * Flushes are CHAINED, not coalesced. Two triggers overlap constantly in
   * practice — the size threshold fires while the timer tick is mid-export —
   * and the obvious `if (inFlight) return inFlight` makes the second caller
   * await the FIRST call's work and then return with its own spans still
   * queued. Chaining serialises the sends (no interleaved writes to `queue`,
   * no batch sent twice) while still guaranteeing that when a caller's promise
   * resolves, the spans that were queued when it called are gone.
   */
  async flush(): Promise<void> {
    const previous = this.inFlight ?? Promise.resolve();
    const next: Promise<void> = previous
      // A failed predecessor must not poison the chain; `send` already
      // swallows and counts its own failures, so this is belt-and-braces.
      .catch(() => undefined)
      .then(() => this.drain())
      .finally(() => {
        if (this.inFlight === next) this.inFlight = null;
      });
    this.inFlight = next;
    return next;
  }

  /**
   * Drain a SNAPSHOT of the queue, not the queue as it evolves.
   *
   * `while (queue.length > 0)` would let a steady arrival rate keep one flush
   * running indefinitely — and since each `send` awaits the network, that flush
   * would hold `inFlight` and starve the scheduled tick. Bounding by the depth
   * observed on entry makes every flush terminate; whatever arrived meanwhile
   * goes out on the next tick, at most `scheduledDelayMs` later.
   */
  private async drain(): Promise<void> {
    let remaining = this.queue.length;
    while (remaining > 0 && this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      remaining -= batch.length;
      await this.send(batch);
    }
  }

  private async send(batch: readonly EndedSpan[]): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.exportTimeoutMs);
    deadline.unref?.();
    try {
      const body = JSON.stringify(encodeSpans(batch, this.serviceName));
      const res = await this.transport(this.endpoint, this.headers, body, controller.signal);
      histogram(METRIC.OTLP_EXPORT_MS, Date.now() - started, undefined, {
        attribute: false,
      });
      if (res.ok) {
        counter(METRIC.OTLP_SPANS_EXPORTED, { status: 'ok' }, batch.length, {
          attribute: false,
        });
        return;
      }
      counter(
        METRIC.OTLP_SPANS_DROPPED,
        // The STATUS CLASS, not the code: `4xx`/`5xx` is enough to route the
        // operator (our payload vs their outage) and keeps the label bounded.
        { reason: res.status === 0 ? 'transport' : `http_${Math.floor(res.status / 100)}xx` },
        batch.length,
        { attribute: false },
      );
      logger.debug(
        { status: res.status, spans: batch.length },
        'observability.otlp_export_rejected',
      );
    } catch (err) {
      counter(METRIC.OTLP_SPANS_DROPPED, { reason: 'transport' }, batch.length, {
        attribute: false,
      });
      logger.debug({ err }, 'observability.otlp_export_failed');
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Stop the timer and make a last attempt to deliver what is queued. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Test/diagnostic: spans waiting to be exported. */
  get pending(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let active: OtlpSpanExporter | null = null;

/**
 * Install the exporter from configuration, if configured.
 *
 * Returns `null` when `MAIA_OTLP_TRACES_ENDPOINT` is unset — the supported
 * "off" state, in which `tracer.ts` short-circuits before allocating anything.
 * Idempotent: a second call with an exporter already installed is a no-op, so
 * repeated `buildServer()` cycles (tests, hot reload) do not stack timers.
 */
export function startOtlpExporter(
  overrides: Partial<OtlpExporterOptions> = {},
): OtlpSpanExporter | null {
  if (active) return active;
  const endpoint = overrides.endpoint ?? config.MAIA_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return null;
  active = new OtlpSpanExporter({
    ...overrides,
    endpoint,
    headers: overrides.headers ?? parseOtlpHeaders(config.MAIA_OTLP_TRACES_HEADERS),
    serviceName: overrides.serviceName ?? config.MAIA_OTLP_SERVICE_NAME,
  });
  active.start();
  setSpanSink(active.enqueue);
  logger.info(
    { service_name: config.MAIA_OTLP_SERVICE_NAME, sample_ratio: config.MAIA_OTLP_SAMPLE_RATIO },
    'observability.otlp_exporter_started',
  );
  return active;
}

export async function stopOtlpExporter(): Promise<void> {
  const current = active;
  active = null;
  setSpanSink(null);
  if (current) await current.shutdown();
}
