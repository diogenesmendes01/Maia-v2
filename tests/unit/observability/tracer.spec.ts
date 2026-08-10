import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Issue #535 §1 — span emission.
 *
 * Four properties this suite exists to lock down, in order of how expensive
 * they are to get wrong in production:
 *
 *   1. tracing OFF is byte-for-byte inert (it ships OFF by default);
 *   2. the OTLP trace id IS the Maia trace id, so the four surfaces join;
 *   3. sampling is derived, so two processes agree on the same turn;
 *   4. the taxonomy cannot overstate coverage.
 */
const cfg = vi.hoisted(() => ({
  endpoint: 'http://collector:4318/v1/traces' as string | undefined,
  ratio: 1,
  strict: false,
}));
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        if (prop === 'MAIA_STRICT_METRIC_LABELS') return cfg.strict;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import {
  currentSpan,
  isDeclaredAncestor,
  recordElapsedSpan,
  setSpanSink,
  shouldSampleTrace,
  traceIdToW3C,
  tracingEnabled,
  withSpan,
  type EndedSpan,
} from '../../../src/observability/tracer.js';
import { runWithCorrelation } from '../../../src/observability/correlation.js';
import {
  EMITTED_SPANS,
  SPAN,
  SPAN_EMISSION,
  SPAN_NAMES,
  SPAN_PARENT,
} from '../../../src/observability/taxonomy.js';

const TURN_UUID = '550e8400-e29b-41d4-a716-446655440000';

let captured: EndedSpan[] = [];

beforeEach(() => {
  captured = [];
  cfg.endpoint = 'http://collector:4318/v1/traces';
  cfg.ratio = 1;
  setSpanSink((s) => captured.push(s));
});

afterEach(() => setSpanSink(null));

describe('issue #535 — tracer', () => {
  describe('inert by default', () => {
    it('emits nothing with no endpoint configured', async () => {
      cfg.endpoint = undefined;
      expect(tracingEnabled()).toBe(false);
      const out = await withSpan(SPAN.TURN, async () => 'value');
      expect(out).toBe('value');
      expect(captured).toEqual([]);
    });

    it('emits nothing with no sink wired, even with an endpoint', () => {
      setSpanSink(null);
      expect(tracingEnabled()).toBe(false);
    });

    it('does not open an ALS frame when disabled', async () => {
      cfg.endpoint = undefined;
      await withSpan(SPAN.TURN, async () => {
        // No frame ⇒ a nested span cannot accidentally attach to a phantom
        // parent id once tracing is switched back on mid-process.
        expect(currentSpan()).toBeNull();
      });
    });
  });

  describe('transparency — a span is never a control-flow participant', () => {
    it('returns the wrapped value untouched', async () => {
      await expect(withSpan(SPAN.TURN, async () => 42)).resolves.toBe(42);
    });

    it('rethrows the wrapped error untouched and still emits the span', async () => {
      const boom = new Error('boom');
      await expect(withSpan(SPAN.TURN, async () => Promise.reject(boom))).rejects.toBe(
        boom,
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.status).toBe('error');
    });

    it('a sink that throws cannot break the turn', async () => {
      setSpanSink(() => {
        throw new Error('sink exploded');
      });
      await expect(withSpan(SPAN.TURN, async () => 'ok')).resolves.toBe('ok');
    });
  });

  describe('id correlation — one id, four surfaces', () => {
    it('derives the W3C trace id from the Maia trace id losslessly', () => {
      expect(traceIdToW3C(TURN_UUID)).toBe('550e8400e29b41d4a716446655440000');
      expect(traceIdToW3C(TURN_UUID)).toHaveLength(32);
    });

    it('falls back to a random id rather than an invalid all-zero one', () => {
      const zero = traceIdToW3C('00000000-0000-0000-0000-000000000000');
      expect(zero).not.toMatch(/^0+$/);
      expect(traceIdToW3C(undefined)).toMatch(/^[0-9a-f]{32}$/);
    });

    it('a span inside a correlation scope carries that scope trace id', async () => {
      await runWithCorrelation({ trace_id: TURN_UUID, turn_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, async () => undefined),
      );
      expect(captured[0]?.trace_id).toBe('550e8400e29b41d4a716446655440000');
      expect(captured[0]?.attributes.trace_id).toBe(TURN_UUID);
    });

    it('nested spans share the trace id and chain parent → child', async () => {
      await runWithCorrelation({ trace_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, () => withSpan(SPAN.TOOL_DISPATCH, async () => undefined)),
      );
      const [child, parent] = captured;
      expect(parent?.name).toBe(SPAN.TURN);
      expect(child?.name).toBe(SPAN.TOOL_DISPATCH);
      expect(child?.trace_id).toBe(parent?.trace_id);
      expect(child?.parent_span_id).toBe(parent?.span_id);
      expect(parent?.parent_span_id).toBeNull();
    });
  });

  describe('sampling is DERIVED, never rolled', () => {
    it('the same trace id always yields the same verdict', () => {
      const id = traceIdToW3C(TURN_UUID);
      const verdicts = Array.from({ length: 50 }, () => shouldSampleTrace(id, 0.5));
      expect(new Set(verdicts).size).toBe(1);
    });

    it('honours the boundaries exactly', () => {
      const id = traceIdToW3C(TURN_UUID);
      expect(shouldSampleTrace(id, 1)).toBe(true);
      expect(shouldSampleTrace(id, 0)).toBe(false);
    });

    it('distributes roughly uniformly across trace ids', () => {
      const ids = Array.from({ length: 2000 }, (_, i) => traceIdToW3C(`seed-${i}`));
      const hits = ids.filter((id) => shouldSampleTrace(id, 0.25)).length;
      // Binomial(2000, 0.25) has sd ~19; ±5pp is ~4.6 sd. A skewed hash (the
      // real failure mode) lands far outside this, not just at the edge.
      expect(hits / ids.length).toBeGreaterThan(0.2);
      expect(hits / ids.length).toBeLessThan(0.3);
    });

    it('an unsampled turn emits NO span at all', async () => {
      cfg.ratio = 0;
      await withSpan(SPAN.TURN, async () => undefined);
      expect(captured).toEqual([]);
    });

    it('a child never re-rolls: it inherits the parent trace decision', async () => {
      // The parent's trace id is on the ALS frame, so the child samples the
      // SAME id. Half a trace is worse than none — the missing half reads as
      // "that stage never ran".
      await runWithCorrelation({ trace_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, () => withSpan(SPAN.TOOL_DISPATCH, async () => undefined)),
      );
      expect(captured).toHaveLength(2);
      expect(new Set(captured.map((s) => s.trace_id)).size).toBe(1);
    });
  });

  describe('elapsed spans', () => {
    it('reconstructs a window that closed before the process saw it', () => {
      const start = Date.now() - 5_000;
      recordElapsedSpan(SPAN.QUEUE_WAIT, start, start + 5_000, { queue: 'agent' });
      const span = captured[0];
      expect(span?.name).toBe(SPAN.QUEUE_WAIT);
      expect(Number(span!.end_unix_nano - span!.start_unix_nano) / 1e6).toBeCloseTo(
        5_000,
        0,
      );
      expect(span?.attributes.queue).toBe('agent');
    });

    it('never produces a negative duration from reversed clocks', () => {
      // `enqueued_at_ms` crosses processes; NTP skew can put it in the future.
      const now = Date.now();
      recordElapsedSpan(SPAN.QUEUE_WAIT, now + 1_000, now);
      const span = captured[0];
      expect(span!.end_unix_nano >= span!.start_unix_nano).toBe(true);
    });
  });

  describe('attribution + privacy', () => {
    it('stamps the sanctioned system fallback outside a tenant scope', async () => {
      await withSpan(SPAN.TURN, async () => undefined);
      expect(captured[0]?.attributes.tenant_id).toBe('system');
      expect(captured[0]?.attributes.agent_id).toBe('system');
    });

    it('drops a PII attribute a caller tries to attach', async () => {
      await withSpan(SPAN.TURN, async () => undefined, {
        attributes: { telefone: '+5511999999999', tool: 'listar_lancamentos' } as never,
      });
      expect(captured[0]?.attributes.telefone).toBeUndefined();
      expect(captured[0]?.attributes.tool).toBe('listar_lancamentos');
    });

    it('records the terminal status as an attribute, not only an OTLP code', async () => {
      // OTLP has 3 status codes; Maia has 5 outcomes. `blocked` (governance
      // refused) and `timeout` (provider) both map to ERROR and would become
      // indistinguishable if the vocabulary were not preserved verbatim.
      await withSpan(SPAN.TOOL_DISPATCH, async () => Promise.reject(new Error('x')), {
        statusOnError: 'blocked',
      }).catch(() => undefined);
      expect(captured[0]?.status).toBe('blocked');
      expect(captured[0]?.attributes.status).toBe('blocked');
    });
  });

  describe('instrumented tool dispatch', () => {
    it('carries the governance outcome on the span, not only on the counter', async () => {
      // A denial RETURNS normally, so OTLP's status for the span is `ok`.
      // Without the `result` attribute the waterfall would render a blocked
      // dispatch as a clean success and disagree with
      // `maia_tool_dispatch_total` about the very same call.
      const { instrumentToolDispatch } = await import(
        '../../../src/observability/instrumentation.js'
      );
      await instrumentToolDispatch('criar_lancamento', async () => ({
        error: 'tool_not_granted',
      }));
      const span = captured.find((s) => s.name === SPAN.TOOL_DISPATCH);
      expect(span?.attributes.tool).toBe('criar_lancamento');
      expect(span?.attributes.result).toBe('blocked');
    });

    it('nests the dispatch span under the open turn span', async () => {
      const { instrumentToolDispatch } = await import(
        '../../../src/observability/instrumentation.js'
      );
      await runWithCorrelation({ trace_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, () => instrumentToolDispatch('listar', async () => ({ ok: 1 }))),
      );
      const tool = captured.find((s) => s.name === SPAN.TOOL_DISPATCH);
      const turn = captured.find((s) => s.name === SPAN.TURN);
      expect(tool?.parent_span_id).toBe(turn?.span_id);
    });
  });

  describe('taxonomy honesty (the issue’s opening complaint)', () => {
    it('every span declares an emission status', () => {
      for (const name of SPAN_NAMES) {
        expect(SPAN_EMISSION[name], `${name} has no emission status`).toMatch(
          /^(emitted|declared)$/,
        );
      }
    });

    it('the emitted set is exactly what the codebase instruments', () => {
      // Update BOTH sides together. Adding a name to SPAN_EMISSION without an
      // emitter is precisely the "declared reads as covered" failure #535
      // opens with; shipping an emitter without flipping the flag understates
      // coverage in the runbook.
      expect([...EMITTED_SPANS].sort()).toEqual(
        [SPAN.QUEUE_WAIT, SPAN.TOOL_DISPATCH, SPAN.TURN].sort(),
      );
    });

    it('the runtime parent of an emitted span is a DECLARED ancestor', async () => {
      // `tool.dispatch` declares `react.iteration` as its parent, which has no
      // emitter, so at runtime it attaches to `turn`. That is correct — but it
      // must still be an ancestor, not an arbitrary span.
      expect(SPAN_PARENT[SPAN.TOOL_DISPATCH]).toBe(SPAN.REACT_ITERATION);
      expect(isDeclaredAncestor(SPAN.TOOL_DISPATCH, SPAN.TURN)).toBe(true);
      expect(isDeclaredAncestor(SPAN.TURN, SPAN.TOOL_DISPATCH)).toBe(false);
    });
  });
});
