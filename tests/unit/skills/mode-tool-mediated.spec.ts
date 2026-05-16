/**
 * P9a Task 5 — tool_mediated mode tests.
 *
 * Verifica:
 *  - allowed_tools filter (rejeita tools não declaradas)
 *  - max_tool_calls cap (loops infinitos quebram)
 *  - dispatcher chamado com (name, args)
 *  - acumulação de tools_called no output
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

import { toolMediatedMode, setToolDispatcher } from '@/skills/modes/tool-mediated.js';
import { callLLM } from '@/lib/claude.js';

const mockSkill = {
  id: 'tool-skill-1',
  procedure: {
    system_prompt: 'You can call tools.',
    tool_schemas: [
      { name: 'query_balance', description: 'Get balance', input_schema: { type: 'object' } },
      { name: 'unauthorized_tool', description: 'Should be filtered', input_schema: { type: 'object' } },
    ],
  },
  allowed_tools: ['query_balance'],
  runtime_hints: { max_output_tokens: 1000, max_tool_calls: 3 },
} as any;

describe('toolMediatedMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setToolDispatcher(null);
  });

  it('returns text when LLM stops without tool_use', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"answer":"R$1000"}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
      model: 'x',
    });
    const out = await toolMediatedMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(out.answer).toBe('R$1000');
    expect(out._tools_called).toEqual([]);
  });

  it('throws if dispatcher not configured but tool requested', async () => {
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'query_balance', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'x',
      });
    await expect(
      toolMediatedMode({ skill: mockSkill, input: {}, resolvedPolicies: [] }),
    ).rejects.toThrow('tool_dispatcher_not_configured');
  });

  it('dispatches allowed tool and continues to final answer', async () => {
    setToolDispatcher(async (name, _args) => ({ tool: name, balance: 1234 }));
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'query_balance', args: { account: 'X' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"answer":"saldo é 1234"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'x',
      });
    const out = await toolMediatedMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(out.answer).toBe('saldo é 1234');
    expect(out._tools_called).toEqual(['query_balance']);
  });

  it('blocks tools not in allowed_tools (returns error tool_result)', async () => {
    setToolDispatcher(async () => ({}));
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'unauthorized_tool', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"answer":"failed"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'x',
      });
    const out = await toolMediatedMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    // unauthorized_tool was rejected, never made it into _tools_called.
    expect(out._tools_called).toEqual([]);
  });

  it('throws max_tool_calls_exceeded after cap reached', async () => {
    setToolDispatcher(async () => ({ ok: true }));
    // LLM keeps requesting tool calls forever
    vi.mocked(callLLM).mockResolvedValue({
      content: null,
      tool_uses: [{ id: `tn`, tool: 'query_balance', args: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'x',
    });
    await expect(
      toolMediatedMode({ skill: mockSkill, input: {}, resolvedPolicies: [] }),
    ).rejects.toThrow('max_tool_calls_exceeded');
  });
});
