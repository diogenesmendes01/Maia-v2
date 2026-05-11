import { describe, it, expect } from 'vitest';
import {
  buildToolSummary,
  type ToolExecutionSummary,
  DOMAIN_KEYWORDS,
} from '../../src/agent/tool-execution-summary.js';

/**
 * Tool execution summary persistence (issue #73, Repro 2).
 *
 * Each summary describes one tool call's outcome in a way the next turn's
 * prompt can reidrate AS A BLOCK OF SYSTEM CONTEXT (not as text inside an
 * assistant message). result_keys is allowlist-typed (no nested objects,
 * no PII payload by accident).
 */

describe('buildToolSummary', () => {
  it('summarizes schedule_reminder success with concrete result_keys', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_abc',
      tool_name: 'schedule_reminder',
      side_effect: 'write',
      args: { quando: '2026-05-25T15:00:00Z', texto: 'pagar fatura', canal: 'whatsapp' },
      result: {
        series_id: '11111111-1111-1111-1111-111111111111',
        occurrence_id: '22222222-2222-2222-2222-222222222222',
        scheduled_for: '2026-05-25T15:00:00.000Z',
      },
      status: 'success',
    });

    expect(s.status).toBe('success');
    expect(s.tool_name).toBe('schedule_reminder');
    expect(s.side_effect).toBe('write');
    expect(s.result_summary).toMatch(/lembrete/i);
    expect(s.result_summary).toContain('2026-05-25');
    expect(s.result_keys?.series_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(typeof s.occurred_at).toBe('string');
    expect(() => new Date(s.occurred_at).toISOString()).not.toThrow();
  });

  it('summarizes register_transaction success with transacao_id', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_t',
      tool_name: 'register_transaction',
      side_effect: 'write',
      args: { natureza: 'despesa', valor: 240, descricao: 'mercado' },
      result: {
        transacao_id: '33333333-3333-3333-3333-333333333333',
        saldo_apos: 1500.55,
      },
      status: 'success',
    });

    expect(s.result_summary).toMatch(/transa[çc][ãa]o/i);
    expect(s.result_keys?.transacao_id).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('summarizes register_transaction duplicate_suspected branch distinctly', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_dup',
      tool_name: 'register_transaction',
      side_effect: 'write',
      args: { natureza: 'despesa', valor: 240, descricao: 'mercado' },
      result: {
        duplicate_suspected: true,
        existing: {
          transacao_id: 'abc',
          data_competencia: '2026-05-10',
          valor: 240,
          descricao: 'mercado',
        },
      },
      status: 'success',
    });

    expect(s.result_summary.toLowerCase()).toMatch(/duplicat|suspeit/);
    expect(s.result_keys?.transacao_id).toBeUndefined();
  });

  it('summarizes cancel_reminder success', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_c',
      tool_name: 'cancel_reminder',
      side_effect: 'write',
      args: { series_id: 'aaa' },
      result: { cancelled: true, cancelled_occurrence_count: 3 },
      status: 'success',
    });

    expect(s.result_summary).toMatch(/cancel/i);
    expect(s.result_keys?.cancelled_occurrence_count).toBe(3);
  });

  it('summarizes start_recurring_outreach as communication side-effect', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_r',
      tool_name: 'start_recurring_outreach',
      side_effect: 'communication',
      args: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
      result: {
        series_id: 'sss',
        next_occurrence_id: 'ooo',
        next_scheduled_for: '2026-06-01T12:00:00.000Z',
      },
      status: 'success',
    });

    expect(s.side_effect).toBe('communication');
    expect(s.result_summary).toMatch(/recorrente|outreach/i);
  });

  it('produces a generic fallback for tools without a dedicated summarizer', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_x',
      tool_name: 'some_unknown_tool',
      side_effect: 'read',
      args: { foo: 'bar' },
      result: { ok: true },
      status: 'success',
    });

    expect(s.status).toBe('success');
    expect(s.result_summary).toContain('some_unknown_tool');
    expect(s.result_keys).toBeUndefined();
  });

  it('produces an error-shaped summary when status=error', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_e',
      tool_name: 'register_transaction',
      side_effect: 'write',
      args: {},
      result: { error: 'forbidden' },
      status: 'error',
    });

    expect(s.status).toBe('error');
    expect(s.error_summary).toBeDefined();
    expect(s.error_summary).toMatch(/forbidden/i);
    expect(s.result_keys).toBeUndefined();
  });

  it('rejects nested objects in result_keys (allowlist of primitives only)', () => {
    const s = buildToolSummary({
      tool_call_id: 'tu_z',
      tool_name: 'schedule_reminder',
      side_effect: 'write',
      args: { quando: '2026-05-25T15:00:00Z', texto: 'x', canal: 'whatsapp' },
      result: {
        series_id: 'aaa',
        occurrence_id: 'bbb',
        scheduled_for: '2026-05-25T15:00:00.000Z',
        deeply_nested: { not_allowed: { x: 1 } },
      },
      status: 'success',
    });

    if (s.result_keys) {
      for (const v of Object.values(s.result_keys)) {
        const t = typeof v;
        const okPrimitive = t === 'string' || t === 'number' || t === 'boolean';
        const okArray =
          Array.isArray(v) &&
          v.every((x) => typeof x === 'string' || typeof x === 'number');
        expect(okPrimitive || okArray).toBe(true);
      }
    }
  });
});

describe('DOMAIN_KEYWORDS', () => {
  it('defines domain keywords for the side-effect tools we want overlay coverage on', () => {
    expect(DOMAIN_KEYWORDS.schedule_reminder).toContain('agendar');
    expect(DOMAIN_KEYWORDS.schedule_reminder).toContain('lembrete');
    expect(DOMAIN_KEYWORDS.register_transaction).toContain('transação');
    expect(DOMAIN_KEYWORDS.cancel_reminder).toContain('cancelar');
    expect(DOMAIN_KEYWORDS.start_recurring_outreach).toEqual(
      expect.arrayContaining(['agendar', 'recorrente']),
    );
  });

  it('does not include read-only tools in domain keywords (no overlay risk)', () => {
    expect(DOMAIN_KEYWORDS.query_balance).toBeUndefined();
    expect(DOMAIN_KEYWORDS.list_transactions).toBeUndefined();
    expect(DOMAIN_KEYWORDS.recall_memory).toBeUndefined();
  });
});

// Type-only check kept to prevent accidental relaxation of ResultKeys typing.
const _typeCheckBlock = (s: ToolExecutionSummary) => {
  if (s.result_keys) {
    const v = s.result_keys.x;
    // @ts-expect-error nested objects must not be assignable
    s.result_keys.bad = { nested: 1 };
    return v;
  }
  return null;
};
void _typeCheckBlock;
