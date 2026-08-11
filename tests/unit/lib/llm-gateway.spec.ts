/**
 * LLM Gateway — contrato único de chamadas de modelo (issue #508).
 *
 * Cobre os critérios de aceite verificáveis sem provider real:
 *  - tier `fast` resolve REALMENTE o modelo fast (não o main);
 *  - erro de autenticação não gera segunda tentativa;
 *  - `429` respeita `Retry-After` e sem ele usa backoff;
 *  - `5xx` / erro de rede retentam de forma limitada;
 *  - cancelamento antes da chamada e durante o backoff;
 *  - deadline esgotado impede nova tentativa e o fallback;
 *  - deadline total NÃO reinicia a cada retry;
 *  - fallback só acontece quando a política do workload permite, e é
 *    registrado com origem/destino/razão;
 *  - tokens e custo são contabilizados no gateway (não mais no adapter);
 *  - métrica registra sucesso, erro, timeout, rate limit e cancelamento;
 *  - settings main/fast vêm de UMA leitura, cacheada e invalidável;
 *  - nenhum log/erro carrega chave de API ou prompt cru.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  anthropicCreateMock,
  getSettingsMock,
  recordCostMock,
  incCounterMock,
  observeHistogramMock,
} = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  getSettingsMock: vi.fn(),
  recordCostMock: vi.fn(async () => undefined),
  incCounterMock: vi.fn(),
  observeHistogramMock: vi.fn(),
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

vi.mock('@/lib/cost-ledger.js', () => ({ recordLLMCost: recordCostMock }));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: observeHistogramMock,
  // O disjuntor (issue #534) registra `maia_llm_circuit_state` por
  // `(provider, workload)` na primeira chamada de cada combinação.
  setGaugeProvider: vi.fn(),
}));

vi.mock('@/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('@/config/env.js')>('@/config/env.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      OPENROUTER_API_KEY: 'sk-or-test-placeholder',
      // 2 tentativas mantém a suíte rápida: um único backoff por caso.
      CLAUDE_MAX_RETRIES: 2,
      CLAUDE_TIMEOUT_MS: 30000,
      CLAUDE_MODEL_MAIN: 'env-main',
      CLAUDE_MODEL_FAST: 'env-fast',
    },
  };
});

import { executeLLM as executeLLMRaw } from '@/lib/llm/gateway.js';
import { _internal as circuitInternal } from '@/lib/llm/circuit-breaker.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { LLMGatewayError, parseRetryAfterMs, redactErrorText } from '@/lib/llm/errors.js';
import { workloadPolicy } from '@/lib/llm/workloads.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { LLMGatewayRequest, LLMResponse } from '@/lib/llm/types.js';

const DEFAULT_SCOPE = { tenant_id: 'acme', agent_id: 'ana' };

/**
 * Toda chamada ao gateway exige `tenant_id + agent_id` no ALS — é fail-closed
 * de isolamento, não conveniência. Este helper injeta o escopo default para
 * que cada teste não repita o wrapper; os testes que exercitam a AUSÊNCIA de
 * contexto (ou um escopo específico) usam `executeLLMRaw` de propósito.
 */
function executeLLM(r: LLMGatewayRequest): Promise<LLMResponse> {
  return runWithTenantContext(DEFAULT_SCOPE, () => executeLLMRaw(r));
}

const MAIN_MODEL = 'settings-main';
const FAST_MODEL = 'settings-fast';

function okReply(text = 'ok') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

/** Erro no formato que os SDKs Anthropic/OpenAI levantam (status + headers). */
function apiError(status: number, message = 'boom', headers?: Record<string, string>) {
  const err = new Error(message) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

function abortError() {
  const err = new Error('Request was aborted.');
  (err as { name?: string }).name = 'AbortError';
  return err;
}

function req(overrides: Partial<LLMGatewayRequest> = {}): LLMGatewayRequest {
  return {
    workload: 'reasoner',
    system: 'sys',
    messages: [{ role: 'user', content: 'oi' }],
    ...overrides,
  };
}

function counterCalls(name: string): Array<Record<string, string>> {
  return incCounterMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, string>);
}

beforeEach(() => {
  anthropicCreateMock.mockReset();
  recordCostMock.mockClear();
  incCounterMock.mockClear();
  observeHistogramMock.mockClear();
  getSettingsMock.mockReset();
  getSettingsMock.mockResolvedValue({
    main: { value: MAIN_MODEL, source: 'global' },
    fast: { value: FAST_MODEL, source: 'global' },
  });
  invalidateModelCache();
  // O disjuntor é estado de PROCESSO por `(provider, workload)`: sem zerar
  // entre casos, as falhas simuladas de um teste vazariam para a janela do
  // seguinte. O comportamento do disjuntor tem spec próprio
  // (`llm-circuit-breaker.spec.ts`); aqui ele precisa ficar fora do caminho.
  circuitInternal.reset();
});

async function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, fn);
}

// ---------------------------------------------------------------------------
// Resolução de tier e modelo
// ---------------------------------------------------------------------------

describe('executeLLM — resolução de tier', () => {
  it('tier main usa o modelo main das settings', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req({ tier: 'main' }));
    expect(anthropicCreateMock.mock.calls[0]?.[0].model).toBe(MAIN_MODEL);
  });

  it('tier fast usa REALMENTE o modelo fast (nunca cai no main)', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req({ workload: 'risk_classifier' }));
    expect(anthropicCreateMock.mock.calls[0]?.[0].model).toBe(FAST_MODEL);
  });

  it('tier vision compartilha o slug do fast e é rotulado como vision na métrica', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req({ workload: 'vision' }));
    expect(anthropicCreateMock.mock.calls[0]?.[0].model).toBe(FAST_MODEL);
    expect(counterCalls('maia_llm_requests_total')[0]?.tier).toBe('vision');
  });

  it('workload sem tier explícito usa o default da política', async () => {
    expect(workloadPolicy('role_selector').default_tier).toBe('fast');
    expect(workloadPolicy('reasoner').default_tier).toBe('main');
  });

  it('resolve main e fast numa ÚNICA leitura de settings por chamada', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await executeLLM(req());
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cache de settings
// ---------------------------------------------------------------------------

describe('executeLLM — cache de settings', () => {
  it('segunda chamada no mesmo escopo lê do cache (hit) sem tocar o banco', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await withTenant(async () => {
      await executeLLM(req());
      await executeLLM(req());
    });
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(counterCalls('maia_llm_settings_cache_total').map((l) => l.result)).toContain('hit');
  });

  it('escopos de tenant/agent distintos não compartilham entrada de cache', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await runWithTenantContext({ tenant_id: 't1', agent_id: 'a1' }, () => executeLLMRaw(req()));
    await runWithTenantContext({ tenant_id: 't2', agent_id: 'a2' }, () => executeLLMRaw(req()));
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateModelCache força releitura na próxima chamada', async () => {
    anthropicCreateMock.mockResolvedValue(okReply());
    await withTenant(() => executeLLM(req()));
    invalidateModelCache();
    await withTenant(() => executeLLM(req()));
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it('falha de leitura cai no default de env em vez de derrubar a chamada', async () => {
    getSettingsMock.mockRejectedValueOnce(new Error('db down'));
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req());
    expect(anthropicCreateMock.mock.calls[0]?.[0].model).toBe('env-main');
    expect(counterCalls('maia_llm_settings_cache_total').map((l) => l.result)).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// Política de retry
// ---------------------------------------------------------------------------

describe('executeLLM — retry e classificação de erro', () => {
  it('401 (authentication) NÃO gera segunda tentativa nem fallback', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(401, 'invalid api key'));
    await expect(executeLLM(req())).rejects.toMatchObject({ kind: 'authentication' });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('403 (permission) e 400 (invalid_request) também são terminais', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(403));
    await expect(executeLLM(req())).rejects.toMatchObject({ kind: 'permission' });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);

    anthropicCreateMock.mockReset();
    anthropicCreateMock.mockRejectedValue(apiError(400));
    await expect(executeLLM(req())).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('5xx retenta até o teto e então cai no fallback fast', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(okReply('via fallback'));
    const res = await executeLLM(req());
    // CLAUDE_MAX_RETRIES=2 → duas tentativas no main + uma no fast.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3);
    expect(anthropicCreateMock.mock.calls[2]?.[0].model).toBe(FAST_MODEL);
    expect(res.content).toBe('via fallback');
  }, 20000);

  it('429 com Retry-After curto respeita o header em vez do backoff exponencial', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(apiError(429, 'slow down', { 'retry-after': '0.02' }))
      .mockResolvedValueOnce(okReply());
    const t0 = Date.now();
    await executeLLM(req());
    const elapsed = Date.now() - t0;
    // O backoff exponencial mínimo seria ~1000ms; 20ms prova que o header
    // venceu.
    expect(elapsed).toBeLessThan(900);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);
  });

  /**
   * O caso do achado: primário esgota com erro retentável, fallback devolve um
   * terminal. Lançar o erro do primário devolvia ao caller um 5xx retentável
   * quando a causa real era um 401 — mascarando o incidente e induzindo retry
   * externo contra uma chave inválida.
   */
  it('503 no primário + 401 no fallback: o caller recebe o terminal do fallback', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(401, 'invalid api key'));

    const err = await executeLLM(req()).catch((e) => e);

    expect(err.kind).toBe('authentication');
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
    // Duas tentativas no primário + uma no fallback.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('resposta 200 sem conteúdo utilizável é response_invalid, não sucesso', async () => {
    // A Anthropic devolvendo 200 sem `content` — payload do qual não dá para
    // extrair nada. Antes virava `content: null` com `status='ok'`.
    anthropicCreateMock.mockResolvedValue({ stop_reason: 'end_turn', usage: {} });
    const err = await executeLLM(req({ workload: 'role_selector' })).catch((e) => e);
    expect(err.kind).toBe('response_invalid');
    expect(err.retryable).toBe(false);
    expect(counterCalls('maia_llm_requests_total')[0]?.status).toBe('error');
  });

  it('parseRetryAfterMs aceita segundos e HTTP-date, e descarta lixo', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('não é data')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    // Teto: um provider mal comportado não segura o turno por meia hora.
    expect(parseRetryAfterMs('3600')).toBe(60000);
  });

  it('workload single-shot (SDK direto migrado) faz UMA tentativa e não faz fallback', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(503));
    await expect(executeLLM(req({ workload: 'role_selector' }))).rejects.toMatchObject({
      kind: 'provider_5xx',
    });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Deadline e cancelamento
// ---------------------------------------------------------------------------

describe('executeLLM — deadline e cancelamento', () => {
  it('sinal já abortado curto-circuita antes de qualquer I/O', async () => {
    const c = new AbortController();
    c.abort('caller_cancelled');
    await expect(executeLLM(req({ ctx: { signal: c.signal } }))).rejects.toThrow(
      'llm_call_aborted',
    );
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('deadline já vencido é rejeitado como timeout sem chamar o provider', async () => {
    await expect(
      executeLLM(req({ ctx: { deadline_at: Date.now() - 1 } })),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('deadline curto impede o backoff e o fallback (não reinicia a cada retry)', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(503));
    const t0 = Date.now();
    await expect(
      executeLLM(req({ ctx: { deadline_at: Date.now() + 120 } })),
    ).rejects.toMatchObject({ kind: 'timeout' });
    // Uma tentativa; o backoff (≥1s) não cabe no que sobrou do deadline.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('cancelamento durante o backoff curto-circuita o timer e conta como cancelled', async () => {
    anthropicCreateMock.mockRejectedValueOnce(apiError(503));
    const c = new AbortController();
    const p = executeLLM(req({ ctx: { signal: c.signal } }));
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    c.abort('caller_cancelled');
    await expect(p).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(800);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(counterCalls('maia_llm_cancelled_total').length).toBeGreaterThan(0);
  });

  it('abort vindo do SDK preserva name=AbortError para quem casa por nome', async () => {
    anthropicCreateMock.mockRejectedValueOnce(abortError());
    await expect(executeLLM(req())).rejects.toMatchObject({ name: 'AbortError' });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('deadline propaga um AbortSignal real para a requisição do SDK', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req({ ctx: { deadline_at: Date.now() + 5000 } }));
    const opts = anthropicCreateMock.mock.calls[0]?.[1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Teto por tentativa nunca excede o que resta do deadline.
    expect(opts.timeout).toBeLessThanOrEqual(5000);
    // Camada única de retry: o SDK não pode retentar por conta própria.
    expect(opts.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Telemetria, custo e isolamento
// ---------------------------------------------------------------------------

describe('executeLLM — telemetria e custo', () => {
  it('sucesso registra requests_total, tokens e custo com tenant/agent do ALS', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await withTenant(() => executeLLM(req({ pessoa_id: 'p1' })));

    const requests = counterCalls('maia_llm_requests_total');
    expect(requests[0]).toMatchObject({
      tenant_id: 'acme',
      agent_id: 'ana',
      provider: 'anthropic',
      model: MAIN_MODEL,
      tier: 'main',
      workload: 'reasoner',
      status: 'ok',
    });
    const tokens = counterCalls('maia_llm_tokens_total');
    expect(tokens.map((l) => l.kind)).toEqual(expect.arrayContaining(['input', 'output']));
    expect(recordCostMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: MAIN_MODEL, tokens_input: 11, tokens_output: 7, pessoa_id: 'p1' }),
    );
  });

  it('erro também é contabilizado (o adapter pré-#508 só contava sucesso)', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(401));
    await expect(executeLLM(req())).rejects.toBeDefined();
    expect(counterCalls('maia_llm_requests_total')[0]?.status).toBe('error');
    expect(counterCalls('maia_llm_calls_total')[0]?.status).toBe('error');
  });

  it('rate limit tem status próprio na métrica', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(429, 'slow', { 'retry-after': '0.01' }));
    await expect(executeLLM(req({ workload: 'role_selector' }))).rejects.toBeDefined();
    expect(counterCalls('maia_llm_requests_total')[0]?.status).toBe('rate_limit');
  });

  /**
   * Substitui um teste que registrava a chamada sem labels de tenant e seguia
   * em frente — ou seja, tratava contexto ausente como modo de operação. Uma
   * chamada de LLM sempre gasta dinheiro de ALGUÉM; se não dá para dizer de
   * quem, ela não acontece.
   */
  it('sem contexto de ALS a chamada é rejeitada e o gap é sinalizado', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await expect(executeLLMRaw(req())).rejects.toMatchObject({
      kind: 'missing_tenant_context',
      retryable: false,
    });
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    const labels = counterCalls('maia_llm_requests_total')[0] ?? {};
    // Sem labels inventados — e nunca o literal 'default'.
    expect(labels.tenant_id).toBeUndefined();
    expect(Object.values(labels)).not.toContain('default');
    expect(counterCalls('maia_llm_scope_missing_total').length).toBe(1);
  });

  it('fallback é registrado com origem, destino e razão', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(okReply());
    await executeLLM(req());
    expect(counterCalls('maia_llm_fallback_total')[0]).toMatchObject({
      from_model: MAIN_MODEL,
      to_model: FAST_MODEL,
      workload: 'reasoner',
      reason: 'primary_exhausted',
    });
  }, 20000);

  it('cada tentativa é contabilizada com seu desfecho', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(503));
    await expect(executeLLM(req({ workload: 'role_selector' }))).rejects.toBeDefined();
    expect(counterCalls('maia_llm_attempts_total')[0]).toMatchObject({
      outcome: 'provider_5xx',
      workload: 'role_selector',
    });
  });

  /**
   * Antes, só `maia_llm_requests_total` levava o escopo: duração, timeout,
   * cancelamento, fallback, tokens e attempts agregavam todos os tenants. Um
   * tenant sozinho estourando latência ou queimando tokens ficava diluído na
   * média — justamente a pergunta que o operador precisa responder.
   */
  it('TODA emissão tenant-aware carrega tenant_id + agent_id', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());
    await executeLLM(req());

    for (const metric of ['maia_llm_requests_total', 'maia_llm_tokens_total', 'maia_llm_attempts_total']) {
      const calls = counterCalls(metric);
      expect(calls.length, `${metric} não foi emitida`).toBeGreaterThan(0);
      for (const labels of calls) {
        expect(labels, `${metric} sem tenant_id`).toMatchObject({
          tenant_id: 'acme',
          agent_id: 'ana',
        });
      }
    }
    const durationLabels = (observeHistogramMock.mock.calls.find(
      (c) => c[0] === 'maia_llm_request_duration_ms',
    )?.[2] ?? {}) as Record<string, string>;
    expect(durationLabels).toMatchObject({ tenant_id: 'acme', agent_id: 'ana' });
  });

  it('timeout, cancelamento e fallback também levam o escopo', async () => {
    anthropicCreateMock
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(okReply());
    await executeLLM(req());
    expect(counterCalls('maia_llm_fallback_total')[0]).toMatchObject({
      tenant_id: 'acme',
      agent_id: 'ana',
    });

    incCounterMock.mockClear();
    anthropicCreateMock.mockReset();
    anthropicCreateMock.mockRejectedValue(apiError(503));
    // `reasoner` retenta, então o backoff (≥1s) não cabe no que resta do
    // deadline (40ms) e o desfecho é `timeout`, não `error`.
    await executeLLM(
      req({ workload: 'reasoner', ctx: { deadline_at: Date.now() + 40 } }),
    ).catch(() => undefined);
    expect(counterCalls('maia_llm_timeouts_total')[0] ?? {}).toMatchObject({
      tenant_id: 'acme',
      agent_id: 'ana',
    });
  }, 20000);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('LLMGatewayError — redaction', () => {
  it('não vaza chave de API nem header Authorization na mensagem', () => {
    const err = new LLMGatewayError({
      kind: 'invalid_request',
      detail: 'request failed with x-api-key: sk-ant-api03-SUPERSECRETVALUE and Bearer abc.def.ghi',
    });
    expect(err.message).not.toContain('SUPERSECRETVALUE');
    expect(err.message).not.toContain('abc.def.ghi');
    expect(err.message).toContain('[redacted]');
  });

  it('trunca corpo longo de erro para não ecoar prompt inteiro', () => {
    const out = redactErrorText('p'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it('o gateway nunca inclui o prompt na mensagem de erro', async () => {
    const secretPrompt = 'CPF do cliente 123.456.789-00';
    anthropicCreateMock.mockRejectedValue(apiError(401, 'auth failed'));
    const err = await executeLLM(
      req({ messages: [{ role: 'user', content: secretPrompt }] }),
    ).catch((e) => e as Error);
    expect(err.message).not.toContain('123.456.789-00');
  });

  /**
   * O vetor real: um `400` do provider tipicamente ECOA o input. Truncar em
   * 200 caracteres preservava o começo do eco — que é exatamente onde a PII
   * aparece. A correção não é sanitizar melhor: é a mensagem do provider não
   * entrar no erro.
   */
  it('erro de provider que ECOA PII não propaga nada do corpo', async () => {
    const echoed =
      'invalid_request_error: messages.0.content: "Cliente Maria Silva, CPF 123.456.789-00, ' +
      'telefone (11) 98765-4321, transferir R$ 12.500,00 para a conta 4455-6" is too long';
    anthropicCreateMock.mockRejectedValue(
      apiError(400, echoed, { 'request-id': 'req_abc123' }),
    );

    const err = await executeLLM(
      req({ messages: [{ role: 'user', content: 'Maria Silva, CPF 123.456.789-00' }] }),
    ).catch((e) => e as Error & { kind?: string; status?: number; request_id?: string });

    // Nada do corpo do provider — nem o começo, que sobrevivia ao truncamento.
    expect(err.message).not.toContain('Maria Silva');
    expect(err.message).not.toContain('123.456.789-00');
    expect(err.message).not.toContain('98765-4321');
    expect(err.message).not.toContain('12.500');
    expect(err.message).not.toContain('4455-6');
    expect(err.message).not.toContain('is too long');

    // O que SAI é a allowlist: kind + status + request_id.
    expect(err.kind).toBe('invalid_request');
    expect(err.status).toBe(400);
    expect(err.request_id).toBe('req_abc123');
    expect(err.message).toBe('llm_gateway_invalid_request (status=400 request_id=req_abc123)');
  });

  it('nenhum campo enumerável do erro carrega o corpo do provider', async () => {
    const echoed = 'boom: paciente João, CID F32.1, CPF 987.654.321-00';
    anthropicCreateMock.mockRejectedValue(apiError(400, echoed));
    const err = await executeLLM(req()).catch((e) => e);
    // Cobre o caminho "vazou por serializador de log": pino & cia descem em
    // `cause` e em propriedades próprias. Nenhuma pode conter o eco.
    const serialized = JSON.stringify({
      ...(err as object),
      message: (err as Error).message,
      cause: (err as { cause?: unknown }).cause,
    });
    expect(serialized).not.toContain('987.654.321-00');
    expect(serialized).not.toContain('João');
    expect(serialized).not.toContain('F32.1');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});
