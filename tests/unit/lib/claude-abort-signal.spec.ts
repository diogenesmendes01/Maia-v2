/**
 * PR #221 review, item 3 — SDK-level AbortSignal wiring for `callLLM`.
 *
 * The existing skill-runner / mode tests stop at the `callLLM` boundary
 * (they mock `callLLM` directly). That proves the runner→mode→callLLM
 * plumbing but leaves the SDK side unverified: nothing asserts that
 * `messages.create` / `chat.completions.create` actually receive
 * `{ signal }` in their second-argument `RequestOptions`, nor that the
 * retry loop short-circuits on abort.
 *
 * This spec mocks both SDK clients (Anthropic + OpenAI/OpenRouter) and
 * asserts:
 *  - The signal reaches the SDK call as `RequestOptions.signal`.
 *  - A signal that aborts BEFORE `callLLM` is invoked short-circuits
 *    immediately — `messages.create` is never called and no retry
 *    happens (also covers item 4: early cancel before model lookup).
 *  - A signal that aborts during the first attempt (SDK raises
 *    AbortError) does NOT trigger a retry.
 *  - A signal that aborts during the back-off sleep between retries
 *    short-circuits the timer instead of waiting it out (item 5).
 *  - Fallback-catch protection (item 2): if the fast-model fallback is
 *    aborted, the abort error is surfaced, not masked behind the prior
 *    main-model error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { anthropicCreateMock, openaiCreateMock, getMainMock, getFastMock, getSettingsMock } =
  vi.hoisted(() => ({
    anthropicCreateMock: vi.fn(),
    openaiCreateMock: vi.fn(),
    getMainMock: vi.fn(),
    getFastMock: vi.fn(),
    getSettingsMock: vi.fn(),
  }));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

vi.mock('openai', () => {
  const OpenAI = vi.fn(function (this: unknown) {
    return { chat: { completions: { create: openaiCreateMock } } };
  });
  return { default: OpenAI };
});

// Issue #508: o gateway resolve main + fast numa ÚNICA leitura
// (`getCurrentLLMSettings`) em vez das duas operações sequenciais que
// `callLLM` fazia por chamada. Os mocks legados continuam aqui porque as
// asserções de "nada foi lido antes do abort" seguem valendo para eles.
vi.mock('@/lib/llm-settings.js', () => ({
  getCurrentMainModel: getMainMock,
  getCurrentFastModel: getFastMock,
  getCurrentLLMSettings: getSettingsMock,
}));

vi.mock('@/lib/cost-ledger.js', () => ({
  recordLLMCost: vi.fn(async () => undefined),
}));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
  // Registrado pelo disjuntor (issue #534) na primeira chamada de cada
  // `(provider, workload)`.
  setGaugeProvider: vi.fn(),
}));

// Force a deterministic provider + retry count regardless of dev env. The
// `provider` const in claude.ts is selected at module load, so the config
// mock must be applied before each dynamic import below.
vi.mock('@/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      OPENROUTER_API_KEY: 'sk-or-test-placeholder',
      CLAUDE_MAX_RETRIES: 3,
      CLAUDE_MODEL_MAIN: 'claude-test-main',
      OPENROUTER_MODEL_MAIN: 'anthropic/claude-test-main',
    },
  };
});

function happyAnthropicResponse() {
  return {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function happyOpenAIResponse() {
  return {
    choices: [
      {
        message: { content: 'ok', tool_calls: [] },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    model: 'anthropic/claude-test-main',
  };
}

function makeAbortError() {
  const err = new Error('Request was aborted.');
  (err as { name?: string }).name = 'AbortError';
  return err;
}

/**
 * Issue #508 (review rodada 1): o gateway exige `tenant_id + agent_id` no ALS
 * — uma chamada de LLM sempre gasta dinheiro de algum tenant. Estes testes
 * cobrem cancelamento, não isolamento, então rodam sob um escopo fixo.
 */
async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithTenantContext } = await import('@/db/tenant-context.js');
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, fn);
}

describe('callLLM — Anthropic SDK abort wiring (PR #221, item 3)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset();
    openaiCreateMock.mockReset();
    getMainMock.mockReset();
    getFastMock.mockReset();
    getMainMock.mockResolvedValue('claude-test-main');
    getFastMock.mockResolvedValue('claude-test-fast');
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      main: { value: 'claude-test-main', source: 'global' },
      fast: { value: 'claude-test-fast', source: 'global' },
    });
    // Drop the cached module so the `selectProvider()` snapshot uses the
    // current `LLM_PROVIDER` mock value rather than whatever a prior test
    // (in a different describe block) installed.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Issue #508: the gateway now always derives an absolute deadline
   * (`LLM_TURN_DEADLINE_MS`) when the caller doesn't declare one, so the signal
   * handed to the SDK is composed from the caller's signal + the deadline
   * timer — no longer the caller's object by identity. The property that
   * matters is unchanged, and this asserts it directly and more strongly than
   * the old identity check did: while the request is IN FLIGHT, aborting the
   * caller aborts the signal the SDK is holding.
   */
  it('propagates caller cancellation to the signal anthropic.messages.create holds', async () => {
    const { callLLM } = await import('@/lib/claude.js');

    let sdkSignal: AbortSignal | undefined;
    anthropicCreateMock.mockImplementationOnce(
      (_params: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sdkSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(makeAbortError()), {
            once: true,
          });
        }),
    );

    const controller = new AbortController();
    const promise = withScope(() =>
      callLLM({
        workload: 'reasoner',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    );

    // Give the call time to reach the SDK.
    await new Promise((r) => setTimeout(r, 20));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(sdkSignal).toBeInstanceOf(AbortSignal);
    expect(sdkSignal?.aborted).toBe(false);

    controller.abort('caller_cancelled');

    expect(sdkSignal?.aborted).toBe(true);
    await expect(promise).rejects.toBeDefined();
  });

  it('pre-aborted signal short-circuits before the SDK and model lookup (item 4)', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    const controller = new AbortController();
    controller.abort('caller_cancelled');

    await expect(
      callLLM({
        workload: 'reasoner',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    ).rejects.toThrow('llm_call_aborted');

    // Item 4: the early-cancellation check runs before ANY settings read, so
    // neither the legacy per-tier reads nor the issue-#508 joint read fire.
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(getMainMock).not.toHaveBeenCalled();
    expect(getFastMock).not.toHaveBeenCalled();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('does not retry when SDK rejects with AbortError mid-flight', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    anthropicCreateMock.mockRejectedValueOnce(makeAbortError());

    const controller = new AbortController();
    await expect(
      withScope(() =>
        callLLM({
          workload: 'reasoner',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Critical assertion: AbortError must NOT trigger the retry loop.
    // Without the no-retry guard, this would attempt CLAUDE_MAX_RETRIES (3)
    // times plus a fast-model fallback. With it, exactly one call.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('abort during retry back-off short-circuits the sleep (item 5)', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    // First attempt: regular (non-abort) error → triggers the back-off
    // sleep. While we're sleeping, the caller aborts.
    anthropicCreateMock.mockRejectedValueOnce(new Error('500: upstream'));

    const controller = new AbortController();
    const promise = withScope(() =>
      callLLM({
        workload: 'reasoner',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    );

    // Let the first attempt run + reject, then enter the back-off sleep.
    // The first back-off is 2000ms; the test would hang for the full delay
    // unless abortableSleep clears the timer on abort.
    await new Promise((r) => setTimeout(r, 50));
    const tBeforeAbort = Date.now();
    controller.abort('caller_cancelled');

    await expect(promise).rejects.toBeDefined();
    const elapsedAfterAbort = Date.now() - tBeforeAbort;
    // The promise must settle well before the 2000ms back-off would have
    // completed. A generous 1000ms ceiling proves "short-circuited" without
    // being flaky on a slow CI box.
    expect(elapsedAfterAbort).toBeLessThan(1000);
    // Only the first failed attempt ran; no second SDK call after abort.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('fallback-catch: abort during fast-model fallback surfaces abort, not lastErr (item 2)', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    const controller = new AbortController();
    // Main-model retries (CLAUDE_MAX_RETRIES=3) all reject with non-abort
    // errors → loop accumulates lastErr and exits, falls through to the
    // fast-model fallback. The fallback call races with caller cancellation:
    // we simulate the caller aborting just as the SDK raises AbortError.
    //
    // Without item 2's fix, the fallback catch would throw `lastErr ?? err`
    // and surface "500: upstream-3" — masking the abort. With the fix, the
    // abort wins.
    anthropicCreateMock
      .mockRejectedValueOnce(new Error('500: upstream-1'))
      .mockRejectedValueOnce(new Error('500: upstream-2'))
      .mockRejectedValueOnce(new Error('500: upstream-3'))
      .mockImplementationOnce(async () => {
        controller.abort('caller_cancelled');
        throw makeAbortError();
      });

    const err = await withScope(() =>
      callLLM({
        workload: 'reasoner',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    ).catch((e) => e);

    // The abort error has name 'AbortError'. lastErr would have message
    // starting with '500:'. Item 2 ensures abort wins.
    expect(err).toBeDefined();
    expect((err as { name?: string }).name).toBe('AbortError');
    expect((err as Error).message).not.toMatch(/^500:/);
    // Four calls: 3 main-model retries + 1 fast-model fallback.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(4);
  }, 30000);
});

describe('callLLM — OpenRouter (OpenAI SDK) abort wiring (PR #221, item 3)', () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset();
    openaiCreateMock.mockReset();
    getMainMock.mockReset();
    getFastMock.mockReset();
    getMainMock.mockResolvedValue('anthropic/claude-test-main');
    getFastMock.mockResolvedValue('anthropic/claude-test-fast');
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      main: { value: 'anthropic/claude-test-main', source: 'global' },
      fast: { value: 'anthropic/claude-test-fast', source: 'global' },
    });
    vi.resetModules();
    // Swap the config provider to openrouter before importing claude.ts.
    vi.doMock('@/config/env.js', async () => {
      const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
      return {
        ...actual,
        config: {
          ...actual.config,
          LLM_PROVIDER: 'openrouter',
          ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
          OPENROUTER_API_KEY: 'sk-or-test-placeholder',
          CLAUDE_MAX_RETRIES: 3,
          CLAUDE_MODEL_MAIN: 'claude-test-main',
          OPENROUTER_MODEL_MAIN: 'anthropic/claude-test-main',
        },
      };
    });
  });

  afterEach(() => {
    vi.doUnmock('@/config/env.js');
  });

  /** See the Anthropic-side note above: composed signal, same guarantee. */
  it('propagates caller cancellation to the signal openai.chat.completions.create holds', async () => {
    const { callLLM } = await import('@/lib/claude.js');

    let sdkSignal: AbortSignal | undefined;
    openaiCreateMock.mockImplementationOnce(
      (_params: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sdkSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(makeAbortError()), {
            once: true,
          });
        }),
    );

    const controller = new AbortController();
    const promise = withScope(() =>
      callLLM({
        workload: 'reasoner',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    expect(sdkSignal?.aborted).toBe(false);

    controller.abort('caller_cancelled');

    expect(sdkSignal?.aborted).toBe(true);
    await expect(promise).rejects.toBeDefined();
  });

  it('does not retry when OpenAI SDK rejects with AbortError', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    openaiCreateMock.mockRejectedValueOnce(makeAbortError());

    const controller = new AbortController();
    await expect(
      withScope(() =>
        callLLM({
          workload: 'reasoner',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });
});
