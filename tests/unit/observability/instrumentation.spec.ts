import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Issue #535 §2 — tool dispatch and context load.
 *
 * The load-bearing case is `classifyToolResult`. `dispatchTool` signals
 * governance denials by RETURNING `{ error }`, not by throwing, so a wrapper
 * that only catches would record every blocked tool as a success — and the
 * tool-error SLI would read 0% while the agent could not act at all.
 */
import {
  classifyToolResult,
  instrumentContextLoad,
  instrumentToolDispatch,
} from '../../../src/observability/instrumentation.js';
import { CONTEXT_LOAD_STAGE } from '../../../src/observability/taxonomy.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
});

describe('issue #535 — tool dispatch classification', () => {
  it('treats a plain value as success', () => {
    expect(classifyToolResult({ saldo: 100 })).toBe('ok');
    expect(classifyToolResult('texto')).toBe('ok');
    expect(classifyToolResult(null)).toBe('ok');
  });

  it.each(['forbidden', 'tool_not_granted', 'tool_disabled', 'no_entity_in_scope'])(
    'classifies %s as BLOCKED, not error',
    (error) => {
      // Governance refusing is the platform working. Folding it into `error`
      // would make a mis-scoped grant look like an outage — and would make the
      // real error rate unreadable underneath it.
      expect(classifyToolResult({ error })).toBe('blocked');
    },
  );

  it.each([
    'feature_disabled',
    'redis_unavailable_blocked',
    'approval_pending',
    'requires_confirmation',
    'requires_dual_approval',
    'mcp_tool_not_executable',
  ])('classifies the fail-closed refusal %s as BLOCKED, not error', (error) => {
    // These six were the actual defect: the dispatcher and the MCP bridge
    // return them for governance working exactly as designed, and every one of
    // them landed in the default `error` bucket — i.e. inside the numerator of
    // `MaiaToolErrorRateHigh`. The exhaustive proof that no seventh one is
    // hiding lives in `tool-error-codes.spec.ts`.
    expect(classifyToolResult({ error })).toBe('blocked');
  });

  it('classifies invalid_args separately from a broken tool', () => {
    // `invalid` tracks MODEL quality (it produced args Zod rejected); `error`
    // tracks OUR code. They move for opposite reasons.
    expect(classifyToolResult({ error: 'invalid_args' })).toBe('invalid');
    // Same axis: a hallucinated tool name is a malformed CALL, not an outage.
    expect(classifyToolResult({ error: 'unknown_tool' })).toBe('invalid');
  });

  it('keeps genuine operational failures in error', () => {
    expect(classifyToolResult({ error: 'execution_failed' })).toBe('error');
    expect(classifyToolResult({ error: 'mcp_call_failed' })).toBe('error');
    expect(classifyToolResult({ error: 'idempotency_payload_hash_collision' })).toBe('error');
  });

  it('classifies an unknown error string as error', () => {
    expect(classifyToolResult({ error: 'db_timeout' })).toBe('error');
  });

  it('ignores a non-string `error` field', () => {
    expect(classifyToolResult({ error: null })).toBe('ok');
    expect(classifyToolResult({ error: 0 })).toBe('ok');
  });
});

describe('issue #535 — instrumentToolDispatch', () => {
  it('returns the wrapped value untouched', async () => {
    await expect(instrumentToolDispatch('listar', async () => ({ ok: 1 }))).resolves.toEqual(
      { ok: 1 },
    );
  });

  it('emits counter + histogram with the tool and the outcome', async () => {
    await instrumentToolDispatch('listar_lancamentos', async () => ({ rows: [] }));
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_tool_dispatch_total\{.*result="ok".*tool="listar_lancamentos"/);
    expect(metrics).toMatch(/maia_tool_duration_ms_count\{.*tool="listar_lancamentos"/);
  });

  it('records a RETURNED denial as blocked', async () => {
    await instrumentToolDispatch('criar_lancamento', async () => ({
      error: 'tool_not_granted',
    }));
    expect(await renderPrometheus()).toMatch(/maia_tool_dispatch_total\{.*result="blocked"/);
  });

  it('keeps a pending approval OUT of the error SLI series', async () => {
    // End to end through the metric, not just the classifier: a queue of
    // approvals waiting on humans must not appear in
    // `maia:tool_error_ratio:rate5m` (monitoring/alerts/slo.rules.yml).
    await instrumentToolDispatch('criar_lancamento', async () => ({
      error: 'approval_pending',
      details: { ref: 'AP-12345678' },
    }));
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_tool_dispatch_total\{.*result="blocked"/);
    expect(metrics).not.toMatch(/maia_tool_dispatch_total\{.*result="error"/);
  });

  it('records a THROWN failure as error and rethrows', async () => {
    const boom = new Error('db down');
    await expect(
      instrumentToolDispatch('criar_lancamento', async () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    expect(await renderPrometheus()).toMatch(/maia_tool_dispatch_total\{.*result="error"/);
  });

  it('never lets a tool name become an unbounded label', async () => {
    // `tool` is budgeted at 200 distinct values; a bug that passes user input
    // as a tool name must degrade into `__overflow__`, not mint series.
    for (let i = 0; i < 260; i++) {
      await instrumentToolDispatch(`tool_${i}`, async () => 1);
    }
    const metrics = await renderPrometheus();
    expect(metrics).toContain('tool="__overflow__"');
    const distinct = new Set(
      [...metrics.matchAll(/maia_tool_dispatch_total\{[^}]*tool="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(distinct.size).toBeLessThanOrEqual(201);
  });

  it('sanitizes a tool name that looks like PII', async () => {
    await instrumentToolDispatch('5511987654321@s.whatsapp.net', async () => 1);
    const metrics = await renderPrometheus();
    expect(metrics).not.toContain('whatsapp.net');
    expect(metrics).toContain('tool="__sanitized__"');
  });
});

describe('issue #535 — instrumentContextLoad', () => {
  // Estes casos usavam `working_memory` e `episodic`, que nunca tiveram
  // emissor e não estão no vocabulário fechado. Um spec que exercita valores
  // inexistentes documenta uma superfície que não existe — e foi o que deixou
  // a promessa de fatias viva no comentário por tanto tempo. Agora usam o
  // único `stage` real, e o compilador recusa os outros.
  it('emits duration and a slice counter on success', async () => {
    await instrumentContextLoad(CONTEXT_LOAD_STAGE.PACKET, async () => 'slice');
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_context_load_ms_count\{.*stage="packet".*status="ok"/);
    expect(metrics).toMatch(/maia_context_slices_total\{.*stage="packet".*status="ok"/);
  });

  it('marks a failed slice and rethrows', async () => {
    await expect(
      instrumentContextLoad(CONTEXT_LOAD_STAGE.PACKET, async () =>
        Promise.reject(new Error('x')),
      ),
    ).rejects.toThrow('x');
    expect(await renderPrometheus()).toMatch(/maia_context_slices_total\{.*status="error"/);
  });
});
