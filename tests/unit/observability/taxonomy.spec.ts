import { describe, it, expect } from 'vitest';
import {
  SPAN,
  SPAN_NAMES,
  SPAN_PARENT,
  SPANS_REMOVED_IN_535,
  METRIC,
  METRIC_NAMES,
  ALLOWED_LABEL_KEYS,
  FORBIDDEN_LABEL_KEYS,
  FORBIDDEN_KEY_SUBSTRINGS,
  ENUM_VALUES,
  type SpanName,
} from '../../../src/observability/taxonomy.js';

describe('issue #514 — observability taxonomy', () => {
  describe('span tree', () => {
    it('has exactly one root and it is `turn`', () => {
      const roots = SPAN_NAMES.filter((s) => SPAN_PARENT[s] === null);
      expect(roots).toEqual([SPAN.TURN]);
    });

    it('every span has an entry in the parent map', () => {
      for (const s of SPAN_NAMES) {
        expect(Object.prototype.hasOwnProperty.call(SPAN_PARENT, s)).toBe(true);
      }
    });

    it('every parent is itself a known span', () => {
      for (const s of SPAN_NAMES) {
        const parent = SPAN_PARENT[s];
        if (parent === null) continue;
        expect(SPAN_NAMES).toContain(parent);
      }
    });

    it('has no cycles — every span reaches the root', () => {
      for (const s of SPAN_NAMES) {
        let cur: SpanName | null = s;
        let hops = 0;
        while (cur !== null) {
          cur = SPAN_PARENT[cur];
          hops++;
          expect(hops).toBeLessThanOrEqual(SPAN_NAMES.length);
        }
      }
    });

    it('covers the minimum stages the issue requires', () => {
      // Issue #514 §2 — the literal tree. If a stage is dropped from the
      // taxonomy, the SLI it feeds silently disappears; this is the guard.
      //
      // Issue #535 removed THREE of the names #514 drew — `ingress.normalize`,
      // `ingress.persist` and `whatsapp.send` — under the owner's rule that a
      // span living only in the declaration is debt. They are not silently
      // absent from this list: `SPANS_REMOVED_IN_535` in the taxonomy carries
      // the individual technical reason for each, and the case below asserts
      // that this list and that record partition the #514 tree exactly, so a
      // fourth name cannot quietly disappear from either side.
      for (const required of [
        'turn',
        'queue.wait',
        'identity.resolve',
        'audience.resolve',
        'preturn.graph',
        'role.select',
        'procedure.select',
        'risk.classify',
        'decision.evaluate',
        'context.load',
        'prompt.render',
        'react.iteration',
        'llm.request',
        'tool.dispatch',
        'permission.check',
        'constitutional.check',
        'idempotency.claim',
        'handler.execute',
        'outbound.commit',
        'turn.complete',
      ]) {
        expect(SPAN_NAMES).toContain(required);
      }
    });

    it('every name #514 drew is either still a span or has a written removal reason', () => {
      // The guard on the removal record itself. Without it, dropping a fourth
      // name would only mean deleting a line from the list above — which is the
      // silent shrink the `SPANS_REMOVED_IN_535` doc exists to prevent. Here the
      // #514 tree is pinned once, and every member must be accounted for on
      // exactly one side of the split.
      const DECLARED_BY_514 = [
        'turn',
        'ingress.normalize',
        'ingress.persist',
        'queue.wait',
        'identity.resolve',
        'audience.resolve',
        'preturn.graph',
        'role.select',
        'procedure.select',
        'risk.classify',
        'decision.evaluate',
        'context.load',
        'prompt.render',
        'react.iteration',
        'llm.request',
        'tool.dispatch',
        'permission.check',
        'constitutional.check',
        'idempotency.claim',
        'handler.execute',
        'outbound.commit',
        'whatsapp.send',
        'turn.complete',
      ];
      const removed = Object.keys(SPANS_REMOVED_IN_535);
      for (const name of DECLARED_BY_514) {
        const isSpan = (SPAN_NAMES as readonly string[]).includes(name);
        const isRemoved = removed.includes(name);
        expect(
          isSpan !== isRemoved,
          `${name} must be either an emitted span OR carry a removal reason, never both and never neither`,
        ).toBe(true);
      }
      // And nothing may be "removed" that was never in the tree — a stale entry
      // reads as a decision that was made about a name nobody ever declared.
      for (const name of removed) expect(DECLARED_BY_514).toContain(name);
      // The reason must be a real sentence, not an empty placeholder.
      for (const [name, reason] of Object.entries(SPANS_REMOVED_IN_535)) {
        expect(reason.length, `${name} has no removal justification`).toBeGreaterThan(40);
      }
    });
  });

  describe('metric names', () => {
    it('are unique', () => {
      expect(new Set(METRIC_NAMES).size).toBe(METRIC_NAMES.length);
    });

    it('all carry the maia_ prefix', () => {
      for (const m of METRIC_NAMES) expect(m.startsWith('maia_')).toBe(true);
    });

    it('counters end in _total', () => {
      const counters: string[] = [
        METRIC.INBOUND_RECEIVED,
        METRIC.INBOUND_PERSISTED,
        METRIC.INBOUND_DEDUPLICATED,
        METRIC.INBOUND_REJECTED,
        METRIC.TURN_STARTED,
        METRIC.TURN_COMPLETED,
        METRIC.TURN_RECOVERED,
        METRIC.TOOL_DISPATCH,
        METRIC.OUTBOUND_COMMITTED,
        METRIC.OUTBOUND_SEND,
        METRIC.WORKER_RUN,
        METRIC.TRACE_COVERAGE,
        METRIC.LABEL_REJECTED,
        METRIC.LABEL_CARDINALITY_OVERFLOW,
      ];
      for (const c of counters) expect(c.endsWith('_total')).toBe(true);
    });

    it('duration histograms end in _ms', () => {
      const histos: string[] = [
        METRIC.TURN_DURATION_MS,
        METRIC.TURN_E2E_LATENCY_MS,
        METRIC.TURN_DELIVERY_LATENCY_MS,
        METRIC.STAGE_DURATION_MS,
        METRIC.QUEUE_WAIT_MS,
        METRIC.LLM_LATENCY_MS,
        METRIC.TOOL_DURATION_MS,
        METRIC.OUTBOUND_SEND_MS,
        METRIC.WORKER_DURATION_MS,
      ];
      for (const h of histos) expect(h.endsWith('_ms')).toBe(true);
    });

    it('keeps the pre-existing LLM metric names stable', () => {
      // These are already scraped and referenced in docs/runbooks/operational.md.
      // Renaming them would silently break existing dashboards.
      expect(METRIC.LLM_CALLS).toBe('maia_llm_calls_total');
      expect(METRIC.LLM_TOKENS).toBe('maia_llm_tokens_total');
      expect(METRIC.LLM_LATENCY_MS).toBe('maia_llm_latency_ms');
    });
  });

  describe('label policy', () => {
    it('mandates tenant_id + agent_id as allowed dimensions (AGENTS.md §4.1)', () => {
      expect(ALLOWED_LABEL_KEYS.has('tenant_id')).toBe(true);
      expect(ALLOWED_LABEL_KEYS.has('agent_id')).toBe(true);
    });

    it('forbids every identifier class the issue names', () => {
      for (const forbidden of [
        'phone',
        'telefone',
        'jid',
        'pessoa_id',
        'conversa_id',
        'mensagem_id',
        'trace_id',
        'payload',
        'text',
        'url',
        'error',
      ]) {
        expect(FORBIDDEN_LABEL_KEYS.has(forbidden)).toBe(true);
      }
    });

    it('no allowed key contains a forbidden substring', () => {
      for (const key of ALLOWED_LABEL_KEYS) {
        for (const frag of FORBIDDEN_KEY_SUBSTRINGS) {
          expect(
            key.toLowerCase().includes(frag),
            `allowed key "${key}" contains forbidden fragment "${frag}"`,
          ).toBe(false);
        }
      }
    });

    it('enumerated vocabularies are non-empty and lowercase', () => {
      for (const [name, values] of Object.entries(ENUM_VALUES)) {
        expect(values.length, name).toBeGreaterThan(0);
        for (const v of values) expect(v).toBe(v.toLowerCase());
      }
    });
  });
});
