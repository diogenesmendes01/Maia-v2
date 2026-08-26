import { describe, it, expect, vi } from 'vitest';

/**
 * Issue #535 §1 — the span-attribute gate.
 *
 * The OTLP exporter ships to a collector outside our trust boundary, so this
 * suite is the proof that the three privacy layers #514 built survive the new
 * surface: no PII key, no PII value, no unbounded payload — with exactly one
 * documented divergence from the metric gate (correlation ids are ALLOWED on a
 * span, because a span attribute costs no time series).
 */
const cfg = vi.hoisted(() => ({ strictLabels: false }));
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        prop === 'MAIA_STRICT_METRIC_LABELS'
          ? cfg.strictLabels
          : Reflect.get(target, prop, receiver),
    }),
  };
});

import {
  sanitizeSpanAttributes,
  ForbiddenSpanAttributeError,
} from '../../../src/observability/span-attributes.js';
import {
  ALLOWED_LABEL_KEYS,
  FORBIDDEN_LABEL_KEYS,
  MAX_SPAN_ATTRIBUTES,
  SANITIZED_VALUE,
  SPAN_ATTRIBUTE_KEYS,
  SPAN_CORRELATION_KEYS,
} from '../../../src/observability/taxonomy.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('issue #535 — span attribute gate', () => {
  describe('keys', () => {
    it('accepts every metric label key (one bag serves both surfaces)', () => {
      for (const key of ALLOWED_LABEL_KEYS) {
        expect(SPAN_ATTRIBUTE_KEYS.has(key), `${key} missing from span keys`).toBe(true);
      }
    });

    it('drops a key that is on neither list', () => {
      const { attributes, violations } = sanitizeSpanAttributes('turn', {
        invented_key: 'x',
      });
      expect(attributes).toEqual({});
      expect(violations).toEqual([{ key: 'invented_key', reason: 'key_not_allowed' }]);
    });

    it('drops every PII key the metric gate drops, minus the correlation ids', () => {
      for (const key of FORBIDDEN_LABEL_KEYS) {
        if (SPAN_CORRELATION_KEYS.has(key)) continue;
        const { attributes } = sanitizeSpanAttributes('turn', { [key]: 'value' });
        expect(attributes[key], `${key} leaked onto a span`).toBeUndefined();
      }
    });

    it.each([
      'sender_phone',
      'remote_jid',
      'customer_email',
      'tool_error_message',
      'raw_payload',
      'user_prompt',
    ])('drops %s via the substring guard', (key) => {
      const { attributes } = sanitizeSpanAttributes('turn', { [key]: 'x' });
      expect(attributes).toEqual({});
    });
  });

  describe('correlation ids — the ONE deliberate divergence from labels.ts', () => {
    it.each([...SPAN_CORRELATION_KEYS])('keeps %s', (key) => {
      const { attributes, violations } = sanitizeSpanAttributes('turn', { [key]: UUID });
      expect(attributes[key]).toBe(UUID);
      expect(violations).toEqual([]);
    });

    it('a UUID survives the phone-shape guard that would otherwise eat it', () => {
      // Regression guard: `looksLikePii` rejects `\+?\d[\d\s().-]{7,}`, and a
      // UUID's last group (446655440000) matches it. Without the UUID
      // exemption every trace id would export as `__sanitized__` and the spans
      // would be unjoinable — the exporter would ship, and be useless.
      const { attributes } = sanitizeSpanAttributes('turn', { trace_id: UUID });
      expect(attributes.trace_id).not.toBe(SANITIZED_VALUE);
    });

    it('the exemption is a UUID exemption, not an id-key exemption', () => {
      const { attributes } = sanitizeSpanAttributes('turn', {
        trace_id: '+55 11 98765-4321',
      });
      expect(attributes.trace_id).toBe(SANITIZED_VALUE);
    });
  });

  describe('values', () => {
    it.each([
      ['5511987654321@s.whatsapp.net', 'JID'],
      ['120363000000000000@g.us', 'group JID'],
      ['alguem@exemplo.com.br', 'e-mail'],
      ['+55 11 98765-4321', 'phone'],
      ['https://example.com/x', 'URL'],
    ])('replaces %s (%s) with the sentinel', (value) => {
      const { attributes, violations } = sanitizeSpanAttributes('turn', { tool: value });
      expect(attributes.tool).toBe(SANITIZED_VALUE);
      expect(violations[0]?.reason).toBe('value_pii');
    });

    it('replaces free text (spaces / newlines) with the sentinel', () => {
      const { attributes } = sanitizeSpanAttributes('turn', {
        reason: 'o cliente pediu para cancelar',
      });
      expect(attributes.reason).toBe(SANITIZED_VALUE);
    });

    it('keeps typed numbers and booleans without stringifying them', () => {
      const { attributes } = sanitizeSpanAttributes('turn', {
        attempt: 3,
        duration_ms: 12.5,
        sampled: true,
      });
      expect(attributes).toEqual({ attempt: 3, duration_ms: 12.5, sampled: true });
    });

    it('drops non-finite numbers rather than serialising NaN into the batch', () => {
      // A `null`/`NaN` numeric makes some collectors reject the WHOLE batch,
      // so one bad span would take every other span in the batch with it.
      const { attributes, violations } = sanitizeSpanAttributes('turn', {
        duration_ms: Number.NaN,
      });
      expect(attributes).toEqual({});
      expect(violations[0]?.reason).toBe('value_shape');
    });
  });

  describe('bounds', () => {
    it('caps the attribute count so a span cannot become a payload channel', () => {
      const bag: Record<string, string> = {};
      for (const key of SPAN_ATTRIBUTE_KEYS) bag[key] = 'v';
      const { attributes, violations } = sanitizeSpanAttributes('turn', bag);
      expect(Object.keys(attributes).length).toBeLessThanOrEqual(MAX_SPAN_ATTRIBUTES);
      expect(violations.some((v) => v.reason === 'too_many_attributes')).toBe(true);
    });
  });

  describe('strict mode', () => {
    it('throws under MAIA_STRICT_METRIC_LABELS so a leak fails a test', () => {
      cfg.strictLabels = true;
      try {
        expect(() =>
          sanitizeSpanAttributes('turn', { telefone: '+5511999999999' }),
        ).toThrow(ForbiddenSpanAttributeError);
      } finally {
        cfg.strictLabels = false;
      }
    });

    it('never throws in production mode', () => {
      expect(() => sanitizeSpanAttributes('turn', { telefone: 'x' })).not.toThrow();
    });
  });
});
