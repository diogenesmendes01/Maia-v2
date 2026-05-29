/**
 * P9a Task 5 — prompt_only mode tests.
 *
 * Verifica:
 *  - parseJsonResponse aceita JSON puro, JSON em fence, e rejeita inválido
 *  - promptOnlyMode usa runtime_hints.max_output_tokens
 *  - Resposta vazia ou inválida lança erro (mapeado para executor_error pelo runner)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

import { promptOnlyMode, parseJsonResponse } from '@/skills/modes/prompt-only.js';
import { callLLM } from '@/lib/claude.js';

const mockSkill = {
  id: 'skill-1',
  procedure: { system_prompt: 'You are a classifier.' },
  runtime_hints: { max_output_tokens: 500 },
} as any;

describe('parseJsonResponse', () => {
  it('parses pure JSON object', () => {
    expect(parseJsonResponse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON in fenced code block', () => {
    const text = 'Here is the answer:\n```json\n{"verdict":"pass"}\n```\n';
    expect(parseJsonResponse(text)).toEqual({ verdict: 'pass' });
  });

  it('throws on empty response', () => {
    expect(() => parseJsonResponse('')).toThrow('empty_llm_response');
    expect(() => parseJsonResponse('   ')).toThrow('empty_llm_response');
  });

  it('throws on non-JSON text', () => {
    expect(() => parseJsonResponse('not json at all')).toThrow('invalid_json_in_llm_response');
  });

  it('wraps non-object value', () => {
    expect(parseJsonResponse('42')).toEqual({ value: 42 });
  });
});

describe('promptOnlyMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('honors max_output_tokens from runtime_hints', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"x":1}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude',
    });
    await promptOnlyMode({
      skill: mockSkill,
      input: { msg: 'hi' },
      resolvedPolicies: [],
    });
    expect(callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 500 }),
    );
  });

  it('defaults max_tokens to 1024 when no hint', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"x":1}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude',
    });
    await promptOnlyMode({
      skill: { ...mockSkill, runtime_hints: {} },
      input: { msg: 'hi' },
      resolvedPolicies: [],
    });
    expect(callLLM).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));
  });

  it('returns parsed JSON from LLM response', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"classification":"positive","confidence":0.9}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    const out = await promptOnlyMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(out).toEqual({ classification: 'positive', confidence: 0.9 });
  });

  it('uses procedure.system_prompt as system message', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    await promptOnlyMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    expect(callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'You are a classifier.' }),
    );
  });

  // ------------------------------------------------------------------------
  // Issue #220 — AbortSignal propagation from ModeContext to callLLM.
  // ------------------------------------------------------------------------

  it('forwards ctx.signal to callLLM (issue #220)', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"ok":true}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    const controller = new AbortController();
    await promptOnlyMode({
      skill: mockSkill,
      input: {},
      resolvedPolicies: [],
      signal: controller.signal,
    });
    const call = vi.mocked(callLLM).mock.calls[0]?.[0];
    expect(call?.signal).toBe(controller.signal);
  });

  it('signal received by callLLM fires when controller aborts (issue #220)', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(callLLM).mockImplementation(async (params: any) => {
      capturedSignal = params.signal;
      // Simulate a long-running call: resolve only after the signal aborts,
      // mirroring how the SDK behaves when its request is cancelled.
      return await new Promise<any>((_resolve, reject) => {
        params.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('AbortError');
            (err as any).name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const p = promptOnlyMode({
      skill: mockSkill,
      input: {},
      resolvedPolicies: [],
      signal: controller.signal,
    });
    // Caller cancels — e.g. SkillRunner timeout fired.
    controller.abort('skill_runner_timeout');
    await expect(p).rejects.toThrow();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    // Reason is preserved through the chain (issue #220 requirement).
    expect(capturedSignal?.reason).toBe('skill_runner_timeout');
  });

  it('throws "aborted" without calling LLM when signal is already aborted (issue #220)', async () => {
    const controller = new AbortController();
    controller.abort('caller_cancelled');
    await expect(
      promptOnlyMode({
        skill: mockSkill,
        input: {},
        resolvedPolicies: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('does not pass signal when ctx.signal is undefined (back-compat)', async () => {
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"ok":true}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    });
    await promptOnlyMode({ skill: mockSkill, input: {}, resolvedPolicies: [] });
    const call = vi.mocked(callLLM).mock.calls[0]?.[0];
    expect(call?.signal).toBeUndefined();
  });
});
