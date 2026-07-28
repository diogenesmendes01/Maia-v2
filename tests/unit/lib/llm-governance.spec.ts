/**
 * Governança do LLM Gateway (issue #508): orçamento por tenant+agent e
 * invalidação distribuída do cache de settings.
 *
 * O que estes testes travam:
 *  - a quota é imposta ANTES de qualquer I/O de provider (o ponto de uma quota
 *    é não gastar, não relatar depois);
 *  - `budget_exhausted` não é retentável e não vira fallback;
 *  - o orçamento é escopado por `tenant_id + agent_id` — estourar num tenant
 *    não bloqueia outro;
 *  - falha na leitura do ledger degrada aberto COM sinal operacional, e não
 *    silenciosamente;
 *  - a mensagem de erro não vaza número de gasto;
 *  - a mensagem de invalidação solta o cache local (é o que faz a troca de
 *    modelo no Admin valer em todas as réplicas).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock, getSettingsMock, readDailyUsdMock, incCounterMock, publishMock } =
  vi.hoisted(() => ({
    anthropicCreateMock: vi.fn(),
    getSettingsMock: vi.fn(),
    readDailyUsdMock: vi.fn(),
    incCounterMock: vi.fn(),
    publishMock: vi.fn(async () => 1),
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
  readDailyLLMUsd: readDailyUsdMock,
}));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: vi.fn(),
}));

vi.mock('@/lib/redis.js', () => ({ redis: { publish: publishMock } }));

vi.mock('@/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      CLAUDE_MAX_RETRIES: 2,
      CLAUDE_TIMEOUT_MS: 30000,
      // Quota ligada: 5 USD/dia por tenant+agent.
      LLM_DAILY_BUDGET_USD: 5,
    },
  };
});

import { executeLLM } from '@/lib/llm/gateway.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { invalidateSpendCache, isBudgetEnabled } from '@/lib/llm/budget.js';
import {
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  handleLLMSettingsInvalidation,
  publishLLMSettingsInvalidation,
} from '@/lib/llm/cache-invalidation.js';
import { runWithTenantContext, runWithSystemContext } from '@/db/tenant-context.js';

function okReply() {
  return {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function counterCalls(name: string): Array<Record<string, string>> {
  return incCounterMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, string>);
}

const REQ = {
  workload: 'reasoner' as const,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'oi' }],
};

beforeEach(() => {
  anthropicCreateMock.mockReset();
  incCounterMock.mockClear();
  publishMock.mockClear();
  readDailyUsdMock.mockReset();
  readDailyUsdMock.mockResolvedValue(0);
  getSettingsMock.mockReset();
  getSettingsMock.mockResolvedValue({
    main: { value: 'settings-main', source: 'global' },
    fast: { value: 'settings-fast', source: 'global' },
  });
  invalidateModelCache();
  invalidateSpendCache();
});

describe('orçamento diário por tenant+agent', () => {
  it('está ligado quando LLM_DAILY_BUDGET_USD > 0', () => {
    expect(isBudgetEnabled()).toBe(true);
  });

  it('gasto abaixo do teto deixa a chamada passar', async () => {
    readDailyUsdMock.mockResolvedValue(4.99);
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('gasto no teto rejeita ANTES de qualquer I/O de provider', async () => {
    readDailyUsdMock.mockResolvedValue(5);
    await expect(
      runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ)),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    // O ponto da quota: nada foi gasto.
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    // Nem sequer resolvemos modelo — a quota vem antes.
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('budget_exhausted não é retentável e não gera fallback', async () => {
    readDailyUsdMock.mockResolvedValue(10);
    const err = await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('a quota é escopada: estourar num tenant não bloqueia outro', async () => {
    readDailyUsdMock.mockImplementation(async () => 0);
    anthropicCreateMock.mockResolvedValue(okReply());

    // t1 estoura.
    readDailyUsdMock.mockResolvedValueOnce(99);
    await expect(
      runWithTenantContext({ tenant_id: 't1', agent_id: 'a1' }, () => executeLLM(REQ)),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });

    // t2 tem seu próprio orçamento e passa.
    await runWithTenantContext({ tenant_id: 't2', agent_id: 'a2' }, () => executeLLM(REQ));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('estouro registra métrica com tenant/agent e status próprio', async () => {
    readDailyUsdMock.mockResolvedValue(7);
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch(() => undefined);
    expect(counterCalls('maia_llm_budget_exhausted_total')[0]).toMatchObject({
      tenant_id: 'acme',
      agent_id: 'ana',
      workload: 'reasoner',
    });
    expect(counterCalls('maia_llm_requests_total')[0]?.status).toBe('budget_exhausted');
  });

  it('a mensagem de erro não vaza o gasto do tenant', async () => {
    readDailyUsdMock.mockResolvedValue(1234.56);
    const err = await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch((e) => e as Error);
    expect(err.message).not.toContain('1234');
  });

  it('falha ao ler o ledger degrada ABERTO, mas com sinal operacional', async () => {
    readDailyUsdMock.mockRejectedValue(new Error('db down'));
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(counterCalls('maia_llm_budget_check_failures_total').length).toBe(1);
  });

  /**
   * Este teste substitui um que FIXAVA o bug: ele afirmava que "sem contexto
   * de ALS o worker global segue", ou seja, congelava o fail-open como
   * contrato. Perder o contexto era um bypass da cota — e um teste verde
   * defendendo isso é pior que nenhum teste.
   */
  it('sem contexto de ALS a chamada é REJEITADA antes de qualquer I/O', async () => {
    readDailyUsdMock.mockResolvedValue(999);
    await expect(executeLLM(REQ)).rejects.toMatchObject({ kind: 'missing_tenant_context' });
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('trabalho global roda sob runWithSystemContext e tem quota própria', async () => {
    readDailyUsdMock.mockResolvedValue(0);
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await runWithSystemContext(() => executeLLM(REQ));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    // A quota do tenant reservado `system` é avaliada como a de qualquer outro.
    expect(readDailyUsdMock).toHaveBeenCalled();
  });

  it('o tenant reservado `system` também estoura quota — não é isento', async () => {
    readDailyUsdMock.mockResolvedValue(50);
    await expect(runWithSystemContext(() => executeLLM(REQ))).rejects.toMatchObject({
      kind: 'budget_exhausted',
    });
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});

describe('invalidação distribuída do cache de settings', () => {
  it('a mensagem no canal solta o cache local (próxima chamada relê)', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, async () => {
      await executeLLM(REQ);
      await executeLLM(REQ);
    });
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    handleLLMSettingsInvalidation(LLM_SETTINGS_INVALIDATION_CHANNEL);

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it('mensagem de outro canal é ignorada', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    handleLLMSettingsInvalidation('outro:canal');
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('publica no canal canônico', async () => {
    await publishLLMSettingsInvalidation();
    expect(publishMock).toHaveBeenCalledWith(
      LLM_SETTINGS_INVALIDATION_CHANNEL,
      expect.any(String),
    );
  });

  it('falha de publish não propaga, mas conta', async () => {
    publishMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(publishLLMSettingsInvalidation()).resolves.toBeUndefined();
    expect(
      counterCalls('maia_llm_settings_cache_total').map((l) => l.result),
    ).toContain('invalidation_publish_failed');
  });
});
