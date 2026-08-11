import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Issue #535 §1 — OTLP/HTTP exporter.
 *
 * The encoding tests are not ceremony: a hand-rolled OTLP payload fails
 * SILENTLY (the collector 4xx's the batch and the spans simply never appear),
 * so the wire contract has to be pinned by tests rather than by a first
 * successful deploy. The delivery tests pin the other half: a bounded queue
 * and counted loss, so a collector outage degrades observability instead of
 * the process it was observing.
 */
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        prop === 'MAIA_OTLP_TRACES_ENDPOINT'
          ? 'http://collector:4318/v1/traces'
          : Reflect.get(target, prop, receiver),
    }),
  };
});

import {
  OtlpSpanExporter,
  encodeSpans,
  parseOtlpHeaders,
  type OtlpTransport,
} from '../../../src/observability/otlp-exporter.js';
import { SPAN } from '../../../src/observability/taxonomy.js';
import type { EndedSpan } from '../../../src/observability/tracer.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';

function span(overrides: Partial<EndedSpan> = {}): EndedSpan {
  return {
    name: SPAN.TURN,
    trace_id: '550e8400e29b41d4a716446655440000',
    span_id: '0011223344556677',
    parent_span_id: null,
    start_unix_nano: 1_700_000_000_000_000_000n,
    end_unix_nano: 1_700_000_001_000_000_000n,
    status: 'ok',
    attributes: { tenant_id: 'primary', agent_id: 'primary' },
    ...overrides,
  };
}

/** Collect the transport calls without touching the network. */
function recordingTransport(result = { ok: true, status: 200 }): {
  transport: OtlpTransport;
  bodies: string[];
} {
  const bodies: string[] = [];
  const transport: OtlpTransport = async (_endpoint, _headers, body) => {
    bodies.push(body);
    return result;
  };
  return { transport, bodies };
}

beforeEach(() => _resetForTests());

describe('issue #535 — OTLP encoding', () => {
  it('produces the resourceSpans → scopeSpans → spans envelope', () => {
    const payload = encodeSpans([span()], 'maia-runtime') as never;
    const resourceSpans = (payload as { resourceSpans: unknown[] }).resourceSpans;
    expect(resourceSpans).toHaveLength(1);
    const rs = resourceSpans[0] as {
      resource: { attributes: { key: string; value: { stringValue: string } }[] };
      scopeSpans: { spans: Record<string, unknown>[] }[];
    };
    expect(
      rs.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue,
    ).toBe('maia-runtime');
    expect(rs.scopeSpans[0]!.spans).toHaveLength(1);
  });

  it('encodes ids as bare lowercase hex (no 0x, no dashes)', () => {
    const s = firstSpan(encodeSpans([span({ parent_span_id: 'aabbccddeeff0011' })], 'x'));
    expect(s.traceId).toBe('550e8400e29b41d4a716446655440000');
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.parentSpanId).toBe('aabbccddeeff0011');
  });

  it('omits parentSpanId entirely on a root span', () => {
    // An empty-string parent is NOT the same as absent: several collectors
    // treat "" as a malformed reference and reject the span.
    const s = firstSpan(encodeSpans([span()], 'x'));
    expect('parentSpanId' in s).toBe(false);
  });

  it('encodes timestamps as STRING nanoseconds', () => {
    // int64 exceeds IEEE-754 exact range, so protobuf-JSON mandates strings.
    // A numeric timestamp silently loses precision or is rejected outright.
    const s = firstSpan(encodeSpans([span()], 'x'));
    expect(s.startTimeUnixNano).toBe('1700000000000000000');
    expect(typeof s.endTimeUnixNano).toBe('string');
  });

  it('encodes integer attributes as intValue STRINGS, floats as doubleValue', () => {
    const s = firstSpan(
      encodeSpans([span({ attributes: { attempt: 3, duration_ms: 1.5, sampled: true } })], 'x'),
    );
    const attrs = s.attributes as { key: string; value: Record<string, unknown> }[];
    expect(attrs.find((a) => a.key === 'attempt')?.value).toEqual({ intValue: '3' });
    expect(attrs.find((a) => a.key === 'duration_ms')?.value).toEqual({ doubleValue: 1.5 });
    expect(attrs.find((a) => a.key === 'sampled')?.value).toEqual({ boolValue: true });
  });

  it('maps ok → 1 and every non-ok outcome → 2, keeping the word in attributes', () => {
    expect(firstSpan(encodeSpans([span({ status: 'ok' })], 'x')).status).toEqual({ code: 1 });
    for (const status of ['error', 'blocked', 'timeout', 'cancelled'] as const) {
      expect(firstSpan(encodeSpans([span({ status })], 'x')).status).toEqual({ code: 2 });
    }
  });

  it('declares SPAN_KIND_INTERNAL, not a fake RPC boundary', () => {
    // Claiming SERVER/CLIENT would make collectors draw service-graph edges
    // between stages of one process.
    expect(firstSpan(encodeSpans([span()], 'x')).kind).toBe(1);
  });

  it('the payload is JSON-serialisable (no BigInt escapes the encoder)', () => {
    expect(() => JSON.stringify(encodeSpans([span()], 'x'))).not.toThrow();
  });
});

describe('issue #535 — header parsing', () => {
  it('parses k=v,k=v', () => {
    expect(parseOtlpHeaders('authorization=Bearer abc,x-tenant=maia')).toEqual({
      authorization: 'Bearer abc',
      'x-tenant': 'maia',
    });
  });

  it('keeps the value intact when it contains an =', () => {
    expect(parseOtlpHeaders('authorization=Basic dXNlcjpwYXNz==')).toEqual({
      authorization: 'Basic dXNlcjpwYXNz==',
    });
  });

  it('skips malformed pairs instead of throwing at boot', () => {
    expect(parseOtlpHeaders('bare,=novalue,k=v')).toEqual({ k: 'v' });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
});

describe('issue #535 — delivery', () => {
  it('flushes automatically once the batch size is reached', async () => {
    const { transport, bodies } = recordingTransport();
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      maxBatchSize: 2,
    });
    exporter.enqueue(span());
    exporter.enqueue(span());
    await exporter.flush();
    expect(bodies).toHaveLength(1);
  });

  it('splits a large queue into batches', async () => {
    const { transport, bodies } = recordingTransport();
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      maxBatchSize: 2,
      maxQueueSize: 10,
    });
    for (let i = 0; i < 5; i++) exporter.enqueue(span());
    await exporter.flush();
    expect(bodies).toHaveLength(3);
  });

  it('drops past the queue bound instead of growing without limit', async () => {
    // A collector outage must not become a heap incident in the process it was
    // supposed to be observing.
    const { transport } = recordingTransport();
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      maxQueueSize: 3,
      maxBatchSize: 100,
    });
    for (let i = 0; i < 50; i++) exporter.enqueue(span());
    expect(exporter.pending).toBe(3);
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_otlp_spans_dropped_total\{reason="queue_full"\} 47/);
  });

  it('counts a transport failure as loss and never throws', async () => {
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    exporter.enqueue(span());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(await renderPrometheus()).toMatch(
      /maia_otlp_spans_dropped_total\{reason="transport"\} 1/,
    );
  });

  it('labels a rejected batch by status CLASS, keeping the label bounded', async () => {
    const { transport } = recordingTransport({ ok: false, status: 429 });
    const exporter = new OtlpSpanExporter({ endpoint: 'http://x/v1/traces', transport });
    exporter.enqueue(span());
    await exporter.flush();
    expect(await renderPrometheus()).toMatch(
      /maia_otlp_spans_dropped_total\{reason="http_4xx"\} 1/,
    );
  });

  it('counts a successful export', async () => {
    const { transport } = recordingTransport();
    const exporter = new OtlpSpanExporter({ endpoint: 'http://x/v1/traces', transport });
    exporter.enqueue(span());
    exporter.enqueue(span());
    await exporter.flush();
    expect(await renderPrometheus()).toMatch(
      /maia_otlp_spans_exported_total\{status="ok"\} 2/,
    );
  });

  it('serialises concurrent flushes so a batch is never sent twice', async () => {
    let inFlight = 0;
    let overlapped = false;
    const transport: OtlpTransport = async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200 };
    };
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      maxBatchSize: 1,
    });
    for (let i = 0; i < 4; i++) exporter.enqueue(span());
    await Promise.all([exporter.flush(), exporter.flush(), exporter.flush()]);
    expect(overlapped).toBe(false);
    expect(exporter.pending).toBe(0);
  });

  it('a flush issued mid-export still drains ITS OWN spans', async () => {
    // Regression: coalescing (`if (inFlight) return inFlight`) made the second
    // caller await the FIRST call's work and resolve with its own spans still
    // queued. The size threshold and the timer tick overlap constantly, so in
    // production this silently held spans back a full interval — or forever,
    // during shutdown.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: string[] = [];
    let duringSend: (() => void) | null = null;
    const transport: OtlpTransport = async (_e, _h, body) => {
      bodies.push(body);
      duringSend?.();
      await gate;
      return { ok: true, status: 200 };
    };
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      maxBatchSize: 10,
    });
    exporter.enqueue(span());
    // A span that arrives WHILE the first export is on the wire — the exact
    // window the timer tick and the size threshold overlap in.
    duringSend = () => {
      duringSend = null;
      exporter.enqueue(span());
    };
    const first = exporter.flush();
    const second = exporter.flush();
    release();
    await Promise.all([first, second]);
    expect(bodies).toHaveLength(2);
    expect(exporter.pending).toBe(0);
  });

  it('after shutdown, further spans are refused and counted, not queued', async () => {
    const { transport } = recordingTransport();
    const exporter = new OtlpSpanExporter({ endpoint: 'http://x/v1/traces', transport });
    await exporter.shutdown();
    exporter.enqueue(span());
    expect(exporter.pending).toBe(0);
    expect(await renderPrometheus()).toMatch(
      /maia_otlp_spans_dropped_total\{reason="shutdown"\} 1/,
    );
  });

  it('shutdown makes a last delivery attempt', async () => {
    const { transport, bodies } = recordingTransport();
    const exporter = new OtlpSpanExporter({ endpoint: 'http://x/v1/traces', transport });
    exporter.enqueue(span());
    await exporter.shutdown();
    expect(bodies).toHaveLength(1);
  });

  it('aborts a hung collector instead of leaking the request forever', async () => {
    const transport: OtlpTransport = (_e, _h, _b, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, status: 0 }));
      });
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://x/v1/traces',
      transport,
      exportTimeoutMs: 20,
    });
    exporter.enqueue(span());
    await exporter.flush();
    expect(await renderPrometheus()).toMatch(
      /maia_otlp_spans_dropped_total\{reason="transport"\} 1/,
    );
  });
});

function firstSpan(payload: Record<string, unknown>): Record<string, never> {
  const rs = (payload as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] })
    .resourceSpans[0]!;
  return rs.scopeSpans[0]!.spans[0] as Record<string, never>;
}
