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

const {
  anthropicCreateMock,
  getSettingsMock,
  readDailyUsdMock,
  estimateCostMock,
  incCounterMock,
  publishMock,
  redisState,
  incrByFloatMock,
  expireMock,
} = vi.hoisted(() => {
  const state = new Map<string, number>();
  return {
    anthropicCreateMock: vi.fn(),
    getSettingsMock: vi.fn(),
    readDailyUsdMock: vi.fn(),
    estimateCostMock: vi.fn(),
    incCounterMock: vi.fn(),
    publishMock: vi.fn(async () => 1),
    redisState: state,
    /**
     * Duplo ATÔMICO de `INCRBYFLOAT`: lê e escreve sem `await` no meio, que é
     * exatamente a garantia que o Redis dá. É o que permite este spec
     * distinguir reserva de check-then-act — com a versão antiga (ler, comparar,
     * seguir) o teste de concorrência abaixo deixaria as 200 chamadas passarem.
     */
    incrByFloatMock: vi.fn(async (key: string, delta: number | string) => {
      const next = (state.get(key) ?? 0) + Number(delta);
      state.set(key, next);
      return String(next);
    }),
    expireMock: vi.fn(async () => 1),
  };
});

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
  estimateLLMCostUsd: estimateCostMock,
}));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: vi.fn(),
}));

vi.mock('@/lib/redis.js', () => ({
  redis: { publish: publishMock, incrbyfloat: incrByFloatMock, expire: expireMock },
}));

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
import { isBudgetEnabled, _internal as budgetInternal } from '@/lib/llm/budget.js';
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

/** Custo estimado/real de UMA chamada nos testes: 0,50 USD → 10 cabem em 5. */
const UNIT_COST_USD = 0.5;

function spendCounter(scope = { tenant_id: 'acme', agent_id: 'ana' }): number {
  return redisState.get(budgetInternal.budgetKey(scope)) ?? 0;
}

beforeEach(() => {
  anthropicCreateMock.mockReset();
  incCounterMock.mockClear();
  publishMock.mockClear();
  expireMock.mockClear();
  incrByFloatMock.mockClear();
  redisState.clear();
  readDailyUsdMock.mockReset();
  readDailyUsdMock.mockResolvedValue(0);
  estimateCostMock.mockReset();
  estimateCostMock.mockResolvedValue(UNIT_COST_USD);
  getSettingsMock.mockReset();
  getSettingsMock.mockResolvedValue({
    main: { value: 'settings-main', source: 'global' },
    fast: { value: 'settings-fast', source: 'global' },
  });
  invalidateModelCache();
});

describe('orçamento diário por tenant+agent', () => {
  it('está ligado quando LLM_DAILY_BUDGET_USD > 0', () => {
    expect(isBudgetEnabled()).toBe(true);
  });

  it('gasto abaixo do teto, com folga para a reserva, deixa passar', async () => {
    readDailyUsdMock.mockResolvedValue(4.0);
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Diferença semântica que a reserva introduz: 4,99 gasto está ABAIXO do teto
   * de 5, mas a chamada custa ~0,50 e levaria a 5,49. Checar o passado deixava
   * passar; reservar o futuro recusa. É esse "só descobre depois de gastar"
   * que o achado aponta.
   */
  it('recusa quando a reserva estouraria o teto, mesmo com gasto atual abaixo dele', async () => {
    readDailyUsdMock.mockResolvedValue(4.99);
    await expect(
      runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ)),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('gasto no teto rejeita ANTES de qualquer I/O de provider', async () => {
    readDailyUsdMock.mockResolvedValue(5);
    await expect(
      runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ)),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
    // O ponto da quota: nada foi gasto. (A resolução de modelo PODE ter
    // ocorrido — é leitura de settings, não I/O de provider, e a estimativa
    // de custo depende do modelo escolhido.)
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('a recusa devolve a própria reserva — quota negada não consome quota', async () => {
    readDailyUsdMock.mockResolvedValue(5);
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch(() => undefined);
    // Sem o rollback, cada tentativa negada deixaria 0,50 preso no contador e
    // a quota encolheria a cada recusa — o pior comportamento possível durante
    // um retry storm.
    expect(spendCounter()).toBeCloseTo(5, 6);
  });

  it('a liquidação ajusta a reserva para o custo REAL', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    // Reserva assume o teto de saída (0,50); o custo real da resposta é 0,02.
    estimateCostMock.mockResolvedValueOnce(UNIT_COST_USD).mockResolvedValueOnce(0.02);
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    expect(spendCounter()).toBeCloseTo(0.02, 6);
  });

  /**
   * O achado da rodada 2: uma tentativa que CHEGOU ao provider já transmitiu o
   * prompt e teve a entrada cobrada. Liquidá-la como custo zero fazia o gasto
   * real divergir do contabilizado exatamente no retry storm — muitas
   * tentativas, poucas respostas — que é o cenário que a quota existe para
   * conter.
   */
  it('tentativa enviada que FALHA é cobrada, não devolvida', async () => {
    anthropicCreateMock.mockRejectedValue(
      Object.assign(new Error('nope'), { status: 401 }),
    );
    // Reserva 0,50 (estimativa) e cobra 0,10 pela entrada transmitida.
    estimateCostMock.mockResolvedValueOnce(UNIT_COST_USD).mockResolvedValue(0.1);

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch(() => undefined);

    expect(spendCounter()).toBeCloseTo(0.1, 6);
  });

  it('retries somam: cada tentativa enviada acumula, não substitui', async () => {
    // `reasoner` com CLAUDE_MAX_RETRIES=2 → 2 tentativas no primário + fallback.
    anthropicCreateMock.mockRejectedValue(
      Object.assign(new Error('upstream'), { status: 503 }),
    );
    estimateCostMock.mockResolvedValueOnce(UNIT_COST_USD).mockResolvedValue(0.1);

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch(() => undefined);

    // 3 requisições enviadas (2 primário + 1 fallback) × 0,10 de entrada cada.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3);
    expect(spendCounter()).toBeCloseTo(0.3, 6);
  }, 20000);

  it('sucesso após uma falha cobra AS DUAS tentativas', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }))
      .mockResolvedValueOnce(okReply());
    estimateCostMock.mockResolvedValueOnce(UNIT_COST_USD).mockResolvedValue(0.1);

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));

    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);
    // 0,10 da tentativa perdida + 0,10 da resposta boa.
    expect(spendCounter()).toBeCloseTo(0.2, 6);
  }, 20000);

  it('usage parcial anexado ao erro é usado quando existe', async () => {
    // Resposta que morreu no meio: o SDK anexou o que foi consumido.
    const partial = Object.assign(new Error('aborted mid-flight'), {
      status: 500,
      usage: { input_tokens: 900, output_tokens: 40 },
    });
    anthropicCreateMock.mockRejectedValue(partial);
    estimateCostMock.mockResolvedValueOnce(UNIT_COST_USD).mockResolvedValue(0.2);

    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM({ ...REQ, workload: 'role_selector' }),
    ).catch(() => undefined);

    // A cobrança usou o usage do erro, não a estimativa de entrada.
    const chargeCall = estimateCostMock.mock.calls.at(-1)?.[0] as {
      tokens_input: number;
      tokens_output: number;
    };
    expect(chargeCall).toMatchObject({ tokens_input: 900, tokens_output: 40 });
    expect(spendCounter()).toBeCloseTo(0.2, 6);
  });

  it('reserva inteira só volta quando NENHUMA requisição saiu', async () => {
    // Recusa por quota: nada foi enviado, nada é cobrado.
    readDailyUsdMock.mockResolvedValue(5);
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM(REQ),
    ).catch(() => undefined);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(spendCounter()).toBeCloseTo(5, 6);
  });

  it('abort ANTES do primeiro envio devolve a reserva inteira', async () => {
    const c = new AbortController();
    c.abort('caller_cancelled');
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      executeLLM({ ...REQ, ctx: { signal: c.signal } }),
    ).catch(() => undefined);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(spendCounter()).toBeCloseTo(0, 6);
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

  it('Redis indisponível degrada ABERTO, mas com sinal operacional', async () => {
    incrByFloatMock.mockRejectedValueOnce(new Error('redis down'));
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () => executeLLM(REQ));
    // Custo é controle financeiro, não de segurança: derrubar o tráfego do
    // tenant por um hiccup de cache seria incidente pior. Mas a degradação
    // precisa ser alertável, não invisível.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(counterCalls('maia_llm_budget_check_failures_total').length).toBe(1);
  });

  /**
   * O teste que o achado pede: 200 chamadas concorrentes contra um teto que
   * comporta 10.
   *
   * Com a versão anterior (ler o gasto acumulado, comparar, seguir) TODAS as
   * 200 liam o mesmo valor inicial e passavam — gasto arbitrário exatamente no
   * cenário em que a quota existe para proteger. Com a reserva atômica, o
   * contador já reflete as reservas concorrentes no momento da comparação.
   */
  it('200 chamadas concorrentes respeitam o teto (reserva atômica, não check-then-act)', async () => {
    const CONCURRENCY = 200;
    const FITS = 10; // teto 5 USD / 0,50 por chamada
    anthropicCreateMock.mockResolvedValue(okReply());

    const results = await runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, () =>
      Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => executeLLM(REQ)),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as { kind?: string }).kind === 'budget_exhausted',
    ).length;

    expect(ok).toBe(FITS);
    expect(rejected).toBe(CONCURRENCY - FITS);
    // Nenhuma chamada a mais chegou ao provider.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(FITS);
    // E o contador nunca ultrapassou o teto.
    expect(spendCounter()).toBeLessThanOrEqual(5 + 1e-6);
  }, 30000);

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
