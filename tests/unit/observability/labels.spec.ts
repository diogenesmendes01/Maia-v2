import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Issue #515 — `MAIA_STRICT_METRIC_LABELS` now comes from the typed config
 * loader, not `process.env`, so a test flips it by overriding the loader. The
 * Proxy keeps every OTHER config key real (the import graph below still boots
 * the logger and the registry), which is what `tests/setup.ts` means by
 * "tests that need a custom config mock `@/config/env.js` directly".
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
  sanitizeLabels,
  _resetLabelGuardForTests,
  _cardinalityFor,
  ForbiddenMetricLabelError,
} from '../../../src/observability/labels.js';
import {
  ALLOWED_LABEL_KEYS,
  FORBIDDEN_LABEL_KEYS,
  CARDINALITY_OVERFLOW_VALUE,
  SANITIZED_VALUE,
  LABEL_CARDINALITY_BUDGET,
  DEFAULT_LABEL_CARDINALITY_BUDGET,
} from '../../../src/observability/taxonomy.js';

describe('issue #514 — metric label sanitizer', () => {
  beforeEach(() => {
    _resetLabelGuardForTests();
    cfg.strictLabels = false;
  });

  describe('key policy', () => {
    it('keeps allowlisted keys', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        tenant_id: 'acme',
        agent_id: 'a1',
        status: 'ok',
      });
      expect(labels).toEqual({ tenant_id: 'acme', agent_id: 'a1', status: 'ok' });
      expect(violations).toEqual([]);
    });

    it('drops keys that are not on the allowlist', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        status: 'ok',
        whatever: 'x',
      });
      expect(labels).toEqual({ status: 'ok' });
      expect(violations).toEqual([{ key: 'whatever', reason: 'key_not_allowed' }]);
    });

    it.each([
      'phone',
      'telefone',
      'jid',
      'remote_jid',
      'pessoa_id',
      'conversa_id',
      'conversation_id',
      'mensagem_id',
      'message_id',
      'trace_id',
      'turno_id',
      'payload',
      'text',
      'content',
      'url',
      'error',
    ])('drops the forbidden key %s', (key) => {
      const { labels, violations } = sanitizeLabels('maia_test_total', { [key]: 'v' });
      expect(labels).toEqual({});
      expect(violations[0]?.reason).toBe('key_forbidden');
    });

    it('drops keys that merely CONTAIN a forbidden fragment', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        customer_phone_number: '5511999999999',
        tool_error_message: 'boom',
        sender_jid_hash: 'abc',
      });
      expect(labels).toEqual({});
      expect(violations.every((v) => v.reason === 'key_forbidden')).toBe(true);
      expect(violations).toHaveLength(3);
    });

    it('the deny list and the allow list never intersect', () => {
      const overlap = [...ALLOWED_LABEL_KEYS].filter((k) => FORBIDDEN_LABEL_KEYS.has(k));
      expect(overlap).toEqual([]);
    });
  });

  describe('value policy', () => {
    it.each([
      ['+55 11 99999-9999', 'phone with separators'],
      ['5511999999999', 'bare long digit run'],
      ['5511999999999@s.whatsapp.net', 'baileys JID'],
      ['120363@g.us', 'baileys group JID'],
      ['someone@example.com', 'email'],
      ['https://evil.example/leak', 'URL'],
    ])('replaces PII-shaped value %s (%s) with the sentinel', (value) => {
      const { labels, violations } = sanitizeLabels('maia_test_total', { reason: value });
      expect(labels.reason).toBe(SANITIZED_VALUE);
      expect(violations[0]?.reason).toBe('value_pii');
    });

    it('replaces free-text values (spaces / newlines) with the sentinel', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        reason: 'connection reset by peer',
      });
      expect(labels.reason).toBe(SANITIZED_VALUE);
      expect(violations[0]?.reason).toBe('value_shape');
    });

    it('replaces over-long values with the sentinel', () => {
      const { labels } = sanitizeLabels('maia_test_total', { reason: 'a'.repeat(200) });
      expect(labels.reason).toBe(SANITIZED_VALUE);
    });

    it('drops empty and nullish values entirely', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        status: '',
        reason: null,
        outcome: undefined,
      });
      expect(labels).toEqual({});
      expect(violations.map((v) => v.reason)).toEqual([
        'value_empty',
        'value_empty',
        'value_empty',
      ]);
    });

    it('accepts UUID and slug shaped ids', () => {
      const { labels, violations } = sanitizeLabels('maia_test_total', {
        tenant_id: '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60',
        agent_id: 'agent-financeiro_01',
      });
      expect(labels.tenant_id).toBe('3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60');
      expect(labels.agent_id).toBe('agent-financeiro_01');
      expect(violations).toEqual([]);
    });
  });

  describe('cardinality budget', () => {
    it('collapses values past the per-key budget into the overflow bucket', () => {
      const budget = LABEL_CARDINALITY_BUDGET.tool ?? DEFAULT_LABEL_CARDINALITY_BUDGET;
      for (let i = 0; i < budget; i++) {
        sanitizeLabels('maia_tool_dispatch_total', { tool: `tool_${i}` });
      }
      expect(_cardinalityFor('maia_tool_dispatch_total', 'tool')).toBe(budget);

      const { labels, violations } = sanitizeLabels('maia_tool_dispatch_total', {
        tool: 'one_too_many',
      });
      expect(labels.tool).toBe(CARDINALITY_OVERFLOW_VALUE);
      expect(violations[0]?.reason).toBe('cardinality_overflow');
      // The memory itself stays bounded — overflow values are NOT remembered.
      expect(_cardinalityFor('maia_tool_dispatch_total', 'tool')).toBe(budget);
    });

    it('re-admits an already-seen value after the budget is exhausted', () => {
      const budget = DEFAULT_LABEL_CARDINALITY_BUDGET;
      for (let i = 0; i < budget; i++) {
        sanitizeLabels('maia_x_total', { status: `s${i}` });
      }
      sanitizeLabels('maia_x_total', { status: 'brand_new' }); // overflow
      const { labels } = sanitizeLabels('maia_x_total', { status: 's0' });
      expect(labels.status).toBe('s0');
    });

    it('budgets are per (metric, key), not global', () => {
      sanitizeLabels('maia_a_total', { queue: 'agent' });
      sanitizeLabels('maia_b_total', { queue: 'agent' });
      expect(_cardinalityFor('maia_a_total', 'queue')).toBe(1);
      expect(_cardinalityFor('maia_b_total', 'queue')).toBe(1);
    });
  });

  describe('strict mode', () => {
    it('throws on any violation when MAIA_STRICT_METRIC_LABELS=true', () => {
      cfg.strictLabels = true;
      expect(() => sanitizeLabels('maia_test_total', { telefone: '5511999999999' })).toThrow(
        ForbiddenMetricLabelError,
      );
    });

    it('stays silent in the default (production) mode', () => {
      expect(() => sanitizeLabels('maia_test_total', { telefone: '5511' })).not.toThrow();
    });

    it('reads the flag through the config loader, not process.env (#515)', () => {
      // Setting the raw env var must NOT change behaviour any more — the value
      // is contract-validated at boot. This is the regression guard for
      // someone "fixing" the loader read back into a direct env read.
      process.env.MAIA_STRICT_METRIC_LABELS = 'true';
      try {
        expect(() => sanitizeLabels('maia_test_total', { telefone: '5511' })).not.toThrow();
      } finally {
        delete process.env.MAIA_STRICT_METRIC_LABELS;
      }
    });
  });
});
