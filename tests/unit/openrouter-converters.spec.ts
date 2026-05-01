import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: {
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_MODEL_MAIN: 'anthropic/claude-sonnet-4-5',
    OPENROUTER_MODEL_FAST: 'anthropic/claude-haiku-4-5',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CLAUDE_MODEL_MAIN: 'claude-sonnet-4-6',
    CLAUDE_MODEL_FAST: 'claude-haiku-4-5-20251001',
    CLAUDE_MAX_RETRIES: 1,
  },
}));

vi.mock('../../src/db/repositories.js', () => ({
  factsRepo: { getByKey: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
}));

vi.mock('../../src/lib/cost-ledger.js', () => ({ recordLLMCost: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/lib/metrics.js', () => ({ incCounter: vi.fn(), observeHistogram: vi.fn() }));

describe('openrouter converters', () => {
  it('toOpenAIMessages prepends system and preserves plain text user/assistant', async () => {
    const { toOpenAIMessages } = await import('../../src/lib/claude.js');
    const out = toOpenAIMessages('SYS', [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'ola' },
    ]);
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'oi' });
    expect(out[2]).toEqual({ role: 'assistant', content: 'ola' });
  });

  it('toOpenAIMessages emits assistant tool_calls + role=tool follow-ups', async () => {
    const { toOpenAIMessages } = await import('../../src/lib/claude.js');
    const out = toOpenAIMessages('SYS', [
      { role: 'user', content: 'qual saldo' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'consultando' },
          { type: 'tool_use', id: 'call_1', name: 'query_balance', input: { entidade: 'e1' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"saldo": 1000}' },
        ],
      },
    ]);
    // [system, user, assistant w/ tool_calls, tool result]
    expect(out.length).toBe(4);
    const asst = out[2] as { role: string; content: string | null; tool_calls?: unknown[] };
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe('consultando');
    expect(asst.tool_calls?.length).toBe(1);
    const tool_call = asst.tool_calls?.[0] as { id: string; type: string; function: { name: string; arguments: string } };
    expect(tool_call.id).toBe('call_1');
    expect(tool_call.function.name).toBe('query_balance');
    expect(JSON.parse(tool_call.function.arguments)).toEqual({ entidade: 'e1' });
    const toolMsg = out[3] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('{"saldo": 1000}');
  });

  it('toOpenAITools maps {name,description,input_schema} to function shape', async () => {
    const { toOpenAITools } = await import('../../src/lib/claude.js');
    const out = toOpenAITools([
      { name: 't1', description: 'd1', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(out?.length).toBe(1);
    expect(out?.[0]).toEqual({
      type: 'function',
      function: {
        name: 't1',
        description: 'd1',
        parameters: { type: 'object', properties: {} },
      },
    });
  });

  it('toOpenAITools returns undefined for empty/missing tools (matches OpenAI SDK shape)', async () => {
    const { toOpenAITools } = await import('../../src/lib/claude.js');
    expect(toOpenAITools(undefined)).toBeUndefined();
    expect(toOpenAITools([])).toBeUndefined();
  });

  it('fromOpenAIResponse maps tool_calls + finish_reason correctly', async () => {
    const { fromOpenAIResponse } = await import('../../src/lib/claude.js');
    const fakeRes = {
      id: 'r1',
      object: 'chat.completion',
      created: 0,
      model: 'anthropic/claude-sonnet-4-5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'pensando',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'query_balance', arguments: '{"entidade":"e1"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = fromOpenAIResponse(fakeRes as any);
    expect(out.content).toBe('pensando');
    expect(out.stop_reason).toBe('tool_use');
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(5);
    expect(out.tool_uses.length).toBe(1);
    expect(out.tool_uses[0]).toEqual({
      id: 'tc_1',
      tool: 'query_balance',
      args: { entidade: 'e1' },
    });
    expect(out.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('fromOpenAIResponse maps stop -> end_turn and length -> max_tokens', async () => {
    const { fromOpenAIResponse } = await import('../../src/lib/claude.js');
    const stopRes = {
      id: 'r2', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const lenRes = {
      id: 'r3', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'truncated' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1024, total_tokens: 1025 },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await import('../../src/lib/claude.js')).fromOpenAIResponse(stopRes as any).stop_reason).toBe('end_turn');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await import('../../src/lib/claude.js')).fromOpenAIResponse(lenRes as any).stop_reason).toBe('max_tokens');
  });
});
