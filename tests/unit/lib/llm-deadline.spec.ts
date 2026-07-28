/**
 * Deadline derivado do LLM Gateway (issue #508, review rodada 1).
 *
 * A mecânica de deadline absoluto compartilhado existia desde a primeira
 * versão — mas o campo era opcional e praticamente nenhum caller o passava. Na
 * prática o gateway rodava com `Infinity`: cada tentativa podia consumir o
 * timeout por requisição inteiro, mais backoff, mais fallback, sem teto
 * agregado. Mecanismo certo, nunca acionado.
 *
 * Este spec usa um `LLM_TURN_DEADLINE_MS` curto e um caller que NÃO declara
 * deadline nenhum — a situação real de todos os call sites hoje — para provar
 * que o limite passou a existir de fato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock, getSettingsMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
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
    return { chat: { completions: { create: vi.fn() } } };
  });
  return { default: OpenAI };
});

vi.mock('@/lib/llm-settings.js', () => ({
  getCurrentLLMSettings: getSettingsMock,
  getCurrentMainModel: vi.fn(),
  getCurrentFastModel: vi.fn(),
}));

vi.mock('@/lib/cost-ledger.js', () => ({
  recordLLMCost: vi.fn(async () => undefined),
  readDailyLLMUsd: vi.fn(async () => 0),
  estimateLLMCostUsd: vi.fn(async () => 0),
}));

vi.mock('@/lib/metrics.js', () => ({ incCounter: vi.fn(), observeHistogram: vi.fn() }));

vi.mock('@/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      CLAUDE_MAX_RETRIES: 3,
      // Teto por tentativa alto de propósito: o que precisa limitar a chamada
      // é o deadline AGREGADO, não o timeout por requisição.
      CLAUDE_TIMEOUT_MS: 30000,
      // Orçamento total curto para o teste ser rápido e determinístico.
      LLM_TURN_DEADLINE_MS: 400,
      LLM_DAILY_BUDGET_USD: 0,
    },
  };
});

import { executeLLM } from '@/lib/llm/gateway.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

const REQ = {
  workload: 'reasoner' as const,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'oi' }],
};

function withScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, fn);
}

function apiError(status: number) {
  return Object.assign(new Error('upstream'), { status });
}

beforeEach(() => {
  anthropicCreateMock.mockReset();
  getSettingsMock.mockReset();
  getSettingsMock.mockResolvedValue({
    main: { value: 'settings-main', source: 'global' },
    fast: { value: 'settings-fast', source: 'global' },
  });
  invalidateModelCache();
});

describe('deadline derivado — caller que não declara nada', () => {
  it('a chamada recebe um deadline finito e ele chega ao SDK', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await withScope(() => executeLLM(REQ));

    const opts = anthropicCreateMock.mock.calls[0]?.[1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Teto por tentativa limitado pelo que resta do deadline (400ms), e não
    // pelos 30s de CLAUDE_TIMEOUT_MS.
    expect(opts.timeout).toBeLessThanOrEqual(400);
  });

  it('o deadline agregado corta os retries — não reinicia a cada tentativa', async () => {
    // 5xx é retentável; sem deadline agregado seriam 3 tentativas com backoff
    // de 1–2s e 2–4s, mais o fallback: dezenas de segundos.
    anthropicCreateMock.mockRejectedValue(apiError(503));

    const t0 = Date.now();
    const err = await withScope(() => executeLLM(REQ)).catch((e) => e);
    const elapsed = Date.now() - t0;

    expect(err.kind).toBe('timeout');
    // O primeiro backoff (≥1s) já não cabe nos 400ms restantes.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it('o deadline agregado também impede o fallback tardio', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(503));
    await withScope(() => executeLLM(REQ)).catch(() => undefined);
    // Nenhuma chamada com o modelo fast: o orçamento acabou antes.
    const models = anthropicCreateMock.mock.calls.map((c) => c[0].model);
    expect(models).not.toContain('settings-fast');
  });

  it('um deadline declarado pelo caller APERTA o limite derivado', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await withScope(() => executeLLM({ ...REQ, ctx: { deadline_at: Date.now() + 50 } }));

    const opts = anthropicCreateMock.mock.calls[0]?.[1];
    expect(opts.timeout).toBeLessThanOrEqual(50);
  });
});
