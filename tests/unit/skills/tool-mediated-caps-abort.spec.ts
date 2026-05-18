/**
 * P9a — tool_mediated runtime_hints caps + AbortSignal.
 *
 * Cobre os requisitos do Codex review #99 finding 3 + mission item 3:
 *  - max_tokens (max_prompt_tokens × iterações) trunca o loop com
 *    `_token_budget_exceeded=true`.
 *  - max_tool_calls cap dispara `_tool_cap_hit=true` no resultado e bloqueia
 *    novas dispatches.
 *  - AbortSignal: abortado entre iterações → throws 'aborted';
 *    toolDispatcher recebe { signal, idempotency_key }.
 *  - Cancelamento durante dispatch propaga para chamador.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

import { toolMediatedMode, setToolDispatcher } from '@/skills/modes/tool-mediated.js';
import { callLLM } from '@/lib/claude.js';

const baseSkill = {
  id: 'tm-1',
  procedure: {
    system_prompt: 'system',
    tool_schemas: [
      { name: 'write_db', description: 'side effect', input_schema: { type: 'object' } },
    ],
  },
  allowed_tools: ['write_db'],
  runtime_hints: {},
} as any;

describe('tool_mediated: max_tool_calls cap', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setToolDispatcher(null);
  });

  it('emite _tool_cap_hit quando o cap é atingido mid-loop', async () => {
    let toolCalls = 0;
    setToolDispatcher(async () => {
      toolCalls++;
      return { written: true };
    });
    const skill = {
      ...baseSkill,
      runtime_hints: { max_tool_calls: 2, max_output_tokens: 100 },
    };
    // LLM pede tool em cada turn, exceto o final que stops.
    vi.mocked(callLLM)
      // turn 1: 1 tool_use (will dispatch — count=1)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      // turn 2: 1 tool_use (will dispatch — count=2)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't2', tool: 'write_db', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      // turn 3: 2 tool_uses (cap already 2; both should hit cap)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [
          { id: 't3', tool: 'write_db', args: {} },
          { id: 't4', tool: 'write_db', args: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      // turn 4 (after cap-hit tool_results): LLM gives up.
      .mockResolvedValueOnce({
        content: '{"answer":"done"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });
    const out = await toolMediatedMode({ skill, input: {}, resolvedPolicies: [] });
    expect(toolCalls).toBe(2);
    expect(out._tool_cap_hit).toBe(true);
    expect(out.answer).toBe('done');
  });
});

describe('tool_mediated: max_tokens budget', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setToolDispatcher(null);
  });

  it('trunca o loop quando max_tokens excedido', async () => {
    setToolDispatcher(async () => ({ ok: true }));
    const skill = {
      ...baseSkill,
      runtime_hints: { max_tool_calls: 10, max_output_tokens: 100, max_tokens: 5 },
    };
    // Cada call retorna 10 tokens — vai estourar no primeiro turno (>5).
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: '{"partial":true}',
      tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 5 },
      model: 'x',
    });
    const out = await toolMediatedMode({ skill, input: {}, resolvedPolicies: [] });
    expect(out._token_budget_exceeded).toBe(true);
    expect(out._tokens_in).toBe(5);
    expect(out._tokens_out).toBe(5);
    // partial body comes from last LLM content.
    expect(out.partial).toBe(true);
  });
});

describe('tool_mediated: AbortSignal propagation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setToolDispatcher(null);
  });

  it('aborta loop entre iterações quando signal.aborted=true', async () => {
    setToolDispatcher(async () => ({ ok: true }));
    const controller = new AbortController();
    const skill = {
      ...baseSkill,
      runtime_hints: { max_tool_calls: 5, max_output_tokens: 100 },
    };
    // LLM nunca para — vamos abortar mid-loop.
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockImplementation(async () => {
        // Antes da segunda iteração, abortamos o signal.
        controller.abort();
        return {
          content: null,
          tool_uses: [{ id: 't2', tool: 'write_db', args: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'x',
        };
      });
    await expect(
      toolMediatedMode({
        skill,
        input: {},
        resolvedPolicies: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });

  it('toolDispatcher recebe signal + idempotency_key', async () => {
    const dispatcherSpy = vi.fn(async (_name: string, _args: unknown, opts?: any) => {
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      expect(typeof opts?.idempotency_key).toBe('string');
      expect(opts.idempotency_key.length).toBeGreaterThan(0);
      return { ok: true };
    });
    setToolDispatcher(dispatcherSpy);
    const controller = new AbortController();
    const skill = {
      ...baseSkill,
      runtime_hints: { max_tool_calls: 2, max_output_tokens: 100 },
    };
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: { x: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"done":true}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });
    const out = await toolMediatedMode({
      skill,
      input: {},
      resolvedPolicies: [],
      signal: controller.signal,
      turno_id: 'turn-42',
    });
    expect(out.done).toBe(true);
    expect(dispatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatcher aborta → propaga como erro "aborted" (não swallow)', async () => {
    const controller = new AbortController();
    setToolDispatcher(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const skill = {
      ...baseSkill,
      runtime_hints: { max_tool_calls: 2, max_output_tokens: 100 },
    };
    vi.mocked(callLLM).mockResolvedValueOnce({
      content: null,
      tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'x',
    });
    await expect(
      toolMediatedMode({
        skill,
        input: {},
        resolvedPolicies: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });
});
