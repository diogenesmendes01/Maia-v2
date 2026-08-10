/**
 * Disjuntor do LLM Gateway por `(provider, workload)` — issue #534.
 *
 * Duas camadas de prova:
 *
 *  1. **Máquina de estados** (`src/lib/llm/circuit-breaker.ts`), exercitada
 *     direto com relógio injetado: abertura por taxa de erro sobre amostra
 *     mínima, half-open com UMA sonda, cooldown geométrico, expiração da
 *     janela, e quais kinds de erro contam como falha do provider.
 *
 *  2. **Teste de carga** através do gateway REAL com o SDK mockado, que é o
 *     critério de aceite textual da issue: "teste de carga que prove a redução
 *     de chamadas durante indisponibilidade". Sem disjuntor, cada request
 *     queima todas as tentativas do workload MAIS o fallback contra um
 *     provider que já está fora — a mesma carga que derrubou o provider é
 *     multiplicada pelo nosso próprio retry.
 *
 * ## Por que todo `beforeEach` fixa `enforce`
 *
 * O default do contrato passou a ser `shadow` (revisão do owner da #534): em
 * produção o disjuntor OBSERVA e não recusa até alguém promover. Este arquivo
 * inteiro descreve o comportamento do `enforce`, então fixa a postura de
 * propósito, uma vez por caso. As posturas `shadow` e `off`, a fidelidade da
 * simulação e o kill switch vivem em `llm-circuit-mode.spec.ts`.
 *
 * Fixar aqui não é contornar o default — é o contrário: se um dia alguém
 * inverter o default de volta para `enforce` sem querer, este arquivo continua
 * verde e o outro pega, que é onde a asserção sobre o default mora.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  anthropicCreateMock,
  getSettingsMock,
  recordCostMock,
  incCounterMock,
  observeHistogramMock,
  setGaugeProviderMock,
  recordCircuitAuditMock,
} = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  getSettingsMock: vi.fn(),
  recordCostMock: vi.fn(async () => undefined),
  incCounterMock: vi.fn(),
  observeHistogramMock: vi.fn(),
  setGaugeProviderMock: vi.fn(),
  recordCircuitAuditMock: vi.fn(),
}));

/**
 * A trilha durável do disjuntor é mockada AQUI de propósito.
 *
 * `circuit-audit.ts` importa `@/governance/audit.js` → `@/db/client.js`, que
 * ABRE um pool de Postgres. Este arquivo é um spec de unidade: deixá-lo escrever
 * no banco de verdade o tornaria dependente de infraestrutura e deixaria linhas
 * espalhadas por outras suítes. O que se prova aqui é o CONTRATO — qual ação a
 * transição emite e com quais metadados. Que a LINHA chega no `audit_log`, e que
 * o watcher a encontra, é provado contra Postgres real em
 * `tests/integration/llm-circuit-audit-real-db.spec.ts`.
 */
vi.mock('@/lib/llm/circuit-audit.js', () => ({
  recordCircuitAudit: recordCircuitAuditMock,
  drainCircuitAudits: vi.fn(async () => undefined),
  _internal: { pendingCount: () => 0 },
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
  recordLLMCost: recordCostMock,
  estimateLLMCostUsd: vi.fn(async () => 0),
  readDailyLLMUsd: vi.fn(async () => 0),
}));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: observeHistogramMock,
  setGaugeProvider: setGaugeProviderMock,
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
      CLAUDE_MODEL_MAIN: 'env-main',
      CLAUDE_MODEL_FAST: 'env-fast',
      // Quota desligada: este spec mede o disjuntor, não o orçamento.
      LLM_DAILY_BUDGET_USD: 0,
    },
  };
});

import {
  acquireCircuit,
  circuitOutcomeFor,
  circuitState,
  peekCircuit,
  releaseCircuit,
  _internal,
} from '@/lib/llm/circuit-breaker.js';
import type { CircuitKey, CircuitOutcome } from '@/lib/llm/circuit-breaker.js';
import { executeLLM as executeLLMRaw } from '@/lib/llm/gateway.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { LLMGatewayRequest, LLMResponse } from '@/lib/llm/types.js';

const KEY: CircuitKey = { provider: 'anthropic', workload: 'reasoner' };
const T0 = 1_800_000_000_000;

function counterCalls(name: string): Array<Record<string, string>> {
  return incCounterMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, string>);
}

/** Registra N desfechos idênticos no estado fechado. */
function feed(key: CircuitKey, outcome: CircuitOutcome, n: number, at = T0): void {
  for (let i = 0; i < n; i++) {
    const permit = acquireCircuit(key, at);
    releaseCircuit(permit, outcome, at);
  }
}

beforeEach(() => {
  _internal.reset();
  _internal.setMode('enforce');
  incCounterMock.mockClear();
  setGaugeProviderMock.mockClear();
  recordCircuitAuditMock.mockClear();
});

/** Ações de auditoria emitidas pelas transições, na ordem. */
function auditedActions(): string[] {
  return recordCircuitAuditMock.mock.calls.map((c) => c[0] as string);
}

// ---------------------------------------------------------------------------
// Máquina de estados
// ---------------------------------------------------------------------------

describe('circuit breaker — abertura por taxa de erro', () => {
  it('fechado deixa passar sem consumir sonda', () => {
    const permit = acquireCircuit(KEY, T0);
    expect(permit.allowed).toBe(true);
    expect(permit.allowed && permit.probe).toBe(false);
    expect(circuitState(KEY)).toBe('closed');
  });

  it('não abre abaixo da amostra mínima, mesmo com 100% de falha', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES - 1);
    expect(circuitState(KEY)).toBe('closed');
  });

  it('abre ao atingir a amostra mínima com a taxa de erro no limiar', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES);
    expect(circuitState(KEY)).toBe('open');
  });

  it('taxa abaixo do limiar mantém fechado', () => {
    feed(KEY, 'fault', 4);
    feed(KEY, 'ok', 6);
    expect(circuitState(KEY)).toBe('closed');
  });

  /**
   * O limiar por TENTATIVA sai do orçamento de tentativas do workload: a janela
   * conta tentativas, mas o caller só perde a chamada quando todas elas E o
   * fallback falham. Ver o comentário de `failureThreshold`.
   */
  it('o limiar é derivado do orçamento de tentativas do workload', () => {
    // `role_selector`: 1 tentativa, sem fallback → o clássico 50%.
    expect(_internal.failureThreshold('role_selector')).toBeCloseTo(0.5, 6);
    // `reasoner`: CLAUDE_MAX_RETRIES(2 no mock) + fallback = 3 tentativas.
    expect(_internal.failureThreshold('reasoner')).toBeCloseTo(0.5 ** (1 / 3), 6);
    expect(_internal.failureThreshold('reasoner')).toBeGreaterThan(
      _internal.failureThreshold('role_selector'),
    );
  });

  it('workload single-shot abre exatamente no limiar de 50% (>=, não >)', () => {
    const single: CircuitKey = { provider: 'anthropic', workload: 'role_selector' };
    feed(single, 'fault', 5);
    feed(single, 'ok', 5);
    expect(circuitState(single)).toBe('open');
  });

  /**
   * A regressão que o harness pegou: com limiar fixo de 50%, um provider
   * errando 70% por tentativa abria o disjuntor de `reasoner` — apesar de a
   * camada de retry ainda estar entregando a maioria das CHAMADAS.
   */
  it('workload com retry NÃO abre num brownout que o retry ainda absorve', () => {
    feed(KEY, 'fault', 7);
    feed(KEY, 'ok', 3);
    expect(circuitState(KEY)).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // ACHADO 1 da revisão adversarial da PR #541 (High)
  //
  // O limiar derivado assumia que TODA falha do provider percorre o orçamento
  // de tentativas. `timeout` não percorre: no gateway ele é terminal
  // (`if (err.kind === 'timeout') { await fail(primary, err); throw err; }`),
  // a chamada morre na primeira tentativa. Medi-lo com a matemática de 4
  // tentativas fazia uma tempestade de timeouts a 70% — em que ~70% das
  // CHAMADAS se perdem, cada uma depois de esperar o timeout inteiro — NÃO
  // abrir o disjuntor, porque 70% < ~84%.
  // -------------------------------------------------------------------------

  it('a taxa estimada de perda de CHAMADAS usa o expoente de cada classe', () => {
    // `CLAUDE_MAX_RETRIES: 2` no mock de config + fallback do `reasoner`.
    expect(_internal.triesPerCall('reasoner')).toBe(3);
    expect(_internal.triesPerCall('role_selector')).toBe(1);

    // Só retentáveis: a chamada só se perde quando as 3 tentativas falham.
    expect(
      _internal.estimatedCallFailureRate('reasoner', { total: 10, faults: 7, terminal: 0 }),
    ).toBeCloseTo(0.7 ** 3, 6);
    // Só terminais: expoente 1 — uma tentativa perdida É uma chamada perdida.
    expect(
      _internal.estimatedCallFailureRate('reasoner', { total: 10, faults: 7, terminal: 7 }),
    ).toBeCloseTo(0.7, 6);
    // Single-shot: as duas classes coincidem, como sempre foram.
    expect(
      _internal.estimatedCallFailureRate('role_selector', { total: 10, faults: 5, terminal: 0 }),
    ).toBeCloseTo(0.5, 6);
  });

  it('70% de fault TERMINAL abre o `reasoner`; 70% de fault RETENTÁVEL não', () => {
    // Mesma taxa por tentativa, mesmas 10 amostras, desfechos de CHAMADA
    // opostos — que é exatamente a distinção que o limiar antigo apagava.
    const terminalKey: CircuitKey = { provider: 'anthropic', workload: 'reasoner' };
    feed(terminalKey, 'terminal_fault', 7);
    feed(terminalKey, 'ok', 3);
    expect(circuitState(terminalKey)).toBe('open');

    const retryableKey: CircuitKey = { provider: 'openrouter', workload: 'reasoner' };
    feed(retryableKey, 'fault', 7);
    feed(retryableKey, 'ok', 3);
    expect(circuitState(retryableKey)).toBe('closed');
  });

  it('janela MISTA soma as duas classes com o expoente de cada uma', () => {
    // 4 terminais (0.4 de perda direta) + 6 retentáveis (0.6³ ≈ 0.216) ⇒ ~0.62.
    feed(KEY, 'terminal_fault', 4);
    feed(KEY, 'fault', 6);
    expect(circuitState(KEY)).toBe('open');

    // 3 terminais (0.3) + 4 retentáveis (0.4³ = 0.064) + 3 ok ⇒ ~0.36 < 0.5.
    const other: CircuitKey = { provider: 'openrouter', workload: 'reasoner' };
    feed(other, 'terminal_fault', 3);
    feed(other, 'fault', 4);
    feed(other, 'ok', 3);
    expect(circuitState(other)).toBe('closed');
  });

  it('falhas fora da janela não contam', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES - 1, T0);
    // A última falha chega depois da janela inteira: as antigas caducaram.
    feed(KEY, 'fault', 1, T0 + _internal.WINDOW_MS + 1);
    expect(circuitState(KEY)).toBe('closed');
  });

  it('desfecho `ignored` não entra na janela', () => {
    feed(KEY, 'ignored', _internal.MIN_SAMPLES * 3);
    expect(circuitState(KEY)).toBe('closed');
    expect(_internal.circuits.get(JSON.stringify(['anthropic', 'reasoner']))?.samples.length).toBe(
      0,
    );
  });

  /**
   * A parte que torna a chave GLOBAL legítima: se um caller conseguisse abrir
   * o disjuntor com payload inválido, teria um vetor de negação de serviço
   * contra todos os outros tenants. Só falha atribuível ao PROVIDER conta.
   */
  it('só kinds atribuíveis ao provider contam como falha', () => {
    expect(circuitOutcomeFor('provider_5xx')).toBe('fault');
    expect(circuitOutcomeFor('network')).toBe('fault');
    // `timeout` continua contando como falha do provider — muda a CLASSE, não a
    // atribuição. Ver `estimatedCallFailureRate` (achado 1 da revisão #541): o
    // timeout do SDK é TERMINAL no gateway (sem retry, sem fallback), então
    // medi-lo com a matemática de múltiplas tentativas escondia a tempestade.
    expect(circuitOutcomeFor('timeout')).toBe('terminal_fault');
    for (const kind of [
      'authentication',
      'permission',
      'invalid_request',
      'response_invalid',
      'budget_exhausted',
      'configuration',
      'missing_tenant_context',
      'aborted',
      'rate_limit',
      'circuit_open',
    ] as const) {
      expect(circuitOutcomeFor(kind), kind).toBe('ignored');
    }
  });

  it('chaves distintas (provider, workload) são disjuntores independentes', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES);
    expect(circuitState(KEY)).toBe('open');
    expect(circuitState({ provider: 'anthropic', workload: 'summarizer' })).toBe('closed');
    expect(circuitState({ provider: 'openrouter', workload: 'reasoner' })).toBe('closed');
  });
});

describe('circuit breaker — aberto e half-open', () => {
  function open(at = T0): void {
    feed(KEY, 'fault', _internal.MIN_SAMPLES, at);
  }

  it('aberto recusa durante o cooldown e informa quanto falta', () => {
    open();
    const permit = acquireCircuit(KEY, T0 + 1_000);
    expect(permit.allowed).toBe(false);
    expect(!permit.allowed && permit.retry_after_ms).toBe(_internal.OPEN_MS - 1_000);
    expect(counterCalls('maia_llm_circuit_short_circuited_total')[0]).toMatchObject({
      provider: 'anthropic',
      workload: 'reasoner',
      state: 'open',
    });
  });

  /** Esgota a janela de half-open com sondas que falham. */
  function failWindow(at: number): void {
    for (let i = 0; i < _internal.HALF_OPEN_MAX_PROBES; i++) {
      const probe = acquireCircuit(KEY, at);
      expect(probe.allowed && probe.probe, `sonda ${i} deveria ser concedida`).toBe(true);
      releaseCircuit(probe, 'fault', at);
    }
  }

  it('passado o cooldown, a janela concede N sondas e recusa o resto', () => {
    open();
    const at = T0 + _internal.OPEN_MS;
    for (let i = 0; i < _internal.HALF_OPEN_MAX_PROBES; i++) {
      const probe = acquireCircuit(KEY, at);
      expect(probe.allowed && probe.probe).toBe(true);
    }
    expect(circuitState(KEY)).toBe('half_open');
    expect(acquireCircuit(KEY, at).allowed).toBe(false);
  });

  it('sonda bem sucedida fecha o disjuntor e zera a janela', () => {
    open();
    const probe = acquireCircuit(KEY, T0 + _internal.OPEN_MS);
    releaseCircuit(probe, 'ok', T0 + _internal.OPEN_MS + 5);
    expect(circuitState(KEY)).toBe('closed');
    // Janela zerada: uma falha isolada logo depois não reabre.
    feed(KEY, 'fault', 1, T0 + _internal.OPEN_MS + 10);
    expect(circuitState(KEY)).toBe('closed');
  });

  /**
   * O achado que o harness de benchmark produziu: com UMA sonda por janela, um
   * provider que ainda serve 30% do tráfego ficava preso em aberto (6 sucessos
   * em 200 requests contra 156 sem disjuntor). Fechar na primeira sonda que
   * passa é o que separa "degradar" de "cair".
   */
  it('basta UMA sonda passar para fechar, mesmo com as outras falhando', () => {
    open();
    const at = T0 + _internal.OPEN_MS;
    const first = acquireCircuit(KEY, at);
    releaseCircuit(first, 'fault', at);
    expect(circuitState(KEY)).toBe('half_open');

    const second = acquireCircuit(KEY, at);
    expect(second.allowed && second.probe).toBe(true);
    releaseCircuit(second, 'ok', at);
    expect(circuitState(KEY)).toBe('closed');
  });

  it('janela inteira de sondas falhando reabre com cooldown maior (com teto)', () => {
    open();
    let at = T0 + _internal.OPEN_MS;
    failWindow(at);
    expect(circuitState(KEY)).toBe('open');
    // Segunda janela: o dobro do cooldown.
    expect(acquireCircuit(KEY, at + _internal.OPEN_MS).allowed).toBe(false);

    at += _internal.OPEN_MS * 2;
    failWindow(at);

    // Cooldown cresce, mas nunca ultrapassa o teto.
    for (let i = 0; i < 8; i++) {
      at += _internal.MAX_OPEN_MS;
      failWindow(at);
    }
    const entry = _internal.circuits.get(JSON.stringify(['anthropic', 'reasoner']))!;
    expect(entry.cooldown_ms).toBe(_internal.MAX_OPEN_MS);
  });

  it('sonda inconclusiva devolve a vaga sem fechar nem reabrir', () => {
    open();
    const at = T0 + _internal.OPEN_MS;
    for (let i = 0; i < _internal.HALF_OPEN_MAX_PROBES + 2; i++) {
      const probe = acquireCircuit(KEY, at);
      expect(probe.allowed && probe.probe, `sonda ${i}`).toBe(true);
      releaseCircuit(probe, 'ignored', at);
    }
    // Continua half_open: nenhuma sonda foi conclusiva, e a janela não se
    // esgotou com cancelamentos.
    expect(circuitState(KEY)).toBe('half_open');
  });

  it('peek não consome vaga de sonda nem transiciona estado', () => {
    open();
    for (let i = 0; i < 10; i++) {
      expect(peekCircuit(KEY, T0 + _internal.OPEN_MS).allowed).toBe(true);
    }
    // O estado ainda é `open` — o peek não transicionou nada.
    expect(circuitState(KEY)).toBe('open');
    // E as N vagas continuam disponíveis.
    for (let i = 0; i < _internal.HALF_OPEN_MAX_PROBES; i++) {
      expect(acquireCircuit(KEY, T0 + _internal.OPEN_MS).allowed).toBe(true);
    }
  });

  it('peek recusa durante o cooldown com o tempo restante', () => {
    open();
    const p = peekCircuit(KEY, T0 + 2_000);
    expect(p).toMatchObject({ allowed: false, state: 'open' });
    expect(p.retry_after_ms).toBe(_internal.OPEN_MS - 2_000);
  });
});

// ---------------------------------------------------------------------------
// Métrica
// ---------------------------------------------------------------------------

describe('circuit breaker — métrica maia_llm_circuit_state', () => {
  /**
   * O gauge é registrado pelo NOME já rotulado, uma série POR ESTADO — mesmo
   * padrão de `maia_lifecycle_state{role,state}` e `maia_whatsapp_sessions`.
   * As chaves saem ordenadas alfabeticamente por `gaugeName()`, e o provider
   * registrado é async porque `observability/metrics.ts` embrulha a leitura
   * para devolver NaN (nunca 0) quando a fonte não pode ser lida.
   */
  function gaugeFor(
    provider: string,
    workload: string,
    state: string,
  ): (() => Promise<number>) | undefined {
    const series = `maia_llm_circuit_state{provider="${provider}",state="${state}",workload="${workload}"}`;
    const hit = setGaugeProviderMock.mock.calls.filter((c) => c[0] === series).pop();
    return hit?.[1] as (() => Promise<number>) | undefined;
  }

  /** Lê as três séries do par e devolve o estado que está valendo 1. */
  async function activeState(provider: string, workload: string): Promise<string[]> {
    const on: string[] = [];
    for (const state of _internal.CIRCUIT_STATES) {
      const g = gaugeFor(provider, workload, state);
      expect(g, `série ${state} não registrada`).toBeTypeOf('function');
      if ((await g!()) === 1) on.push(state);
    }
    return on;
  }

  it('registra as TRÊS séries na PRIMEIRA chamada, antes de qualquer incidente', async () => {
    acquireCircuit(KEY, T0);
    // Uma série que só aparece durante o incidente é inútil para alertar: não
    // há linha de base. As três existem desde a primeira chamada.
    expect(await activeState('anthropic', 'reasoner')).toEqual(['closed']);
  });

  it('exatamente UMA série vale 1 em closed → open → half_open → closed', async () => {
    acquireCircuit(KEY, T0);
    expect(await activeState('anthropic', 'reasoner')).toEqual(['closed']);

    feed(KEY, 'fault', _internal.MIN_SAMPLES);
    expect(await activeState('anthropic', 'reasoner')).toEqual(['open']);

    const probe = acquireCircuit(KEY, T0 + _internal.OPEN_MS);
    expect(await activeState('anthropic', 'reasoner')).toEqual(['half_open']);

    releaseCircuit(probe, 'ok', T0 + _internal.OPEN_MS);
    expect(await activeState('anthropic', 'reasoner')).toEqual(['closed']);
  });

  it('um par (provider, workload) nunca exercitado não tem série alguma', () => {
    acquireCircuit(KEY, T0);
    // Distinguir "nunca exercitado" de "fechado" é justamente o que a
    // codificação numérica 0/1/2 num gauge único não permitia.
    expect(gaugeFor('openrouter', 'vision', 'closed')).toBeUndefined();
    expect(gaugeFor('anthropic', 'reasoner', 'closed')).toBeTypeOf('function');
  });

  it('cada transição incrementa maia_llm_circuit_transitions_total com state/reason', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES);
    const probe = acquireCircuit(KEY, T0 + _internal.OPEN_MS);
    releaseCircuit(probe, 'ok', T0 + _internal.OPEN_MS);

    // `state` é o estado ENTRADO. `from`/`to` não estão em ALLOWED_LABEL_KEYS e
    // seriam descartados em silêncio pelo gate de label da #514 — a transição
    // completa vive no log estruturado, que não tem cardinalidade.
    const transitions = counterCalls('maia_llm_circuit_transitions_total');
    expect(transitions.map((t) => t.state)).toEqual(['open', 'half_open', 'closed']);
    for (const t of transitions) {
      expect(t.provider).toBe('anthropic');
      expect(t.workload).toBe('reasoner');
      expect(t.reason, 'toda transição carrega um motivo').toBeTruthy();
      expect(t).not.toHaveProperty('from');
      expect(t).not.toHaveProperty('to');
    }
  });
});

// ---------------------------------------------------------------------------
// Teste de carga através do gateway real
// ---------------------------------------------------------------------------

const DEFAULT_SCOPE = { tenant_id: 'acme', agent_id: 'ana' };

function executeLLM(r: LLMGatewayRequest): Promise<LLMResponse> {
  return runWithTenantContext(DEFAULT_SCOPE, () => executeLLMRaw(r));
}

function req(overrides: Partial<LLMGatewayRequest> = {}): LLMGatewayRequest {
  return {
    workload: 'role_selector',
    system: 'sys',
    messages: [{ role: 'user', content: 'oi' }],
    ...overrides,
  };
}

/**
 * Erro de provider no formato dos SDKs.
 *
 * O `retry-after` curto no 503 é o que mantém o teste de carga em
 * milissegundos: `classifyProviderError` lê o header em QUALQUER status, então
 * o backoff do gateway encurta sem mudar nada do que está sendo medido —
 * continua sendo `provider_5xx`, continua retentável, continua alimentando o
 * disjuntor.
 */
function apiError(status: number, headers?: Record<string, string>) {
  const err = new Error('boom') as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

function outage() {
  return apiError(503, { 'retry-after': '0.01' });
}

function okReply() {
  return {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function storm(n: number, request: LLMGatewayRequest): Promise<number> {
  let refused = 0;
  for (let i = 0; i < n; i++) {
    await executeLLM(request).catch((e) => {
      if ((e as { kind?: string }).kind === 'circuit_open') refused++;
    });
  }
  return refused;
}

describe('teste de carga — o disjuntor reduz a carga durante indisponibilidade', () => {
  beforeEach(() => {
    _internal.reset();
    _internal.setMode('enforce');
    anthropicCreateMock.mockReset();
    recordCostMock.mockClear();
    incCounterMock.mockClear();
    observeHistogramMock.mockClear();
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      main: { value: 'settings-main', source: 'global' },
      fast: { value: 'settings-fast', source: 'global' },
    });
    invalidateModelCache();
  });

  const REQUESTS = 60;

  it('workload single-shot: 60 requests durante a queda param em ~amostra mínima de chamadas', async () => {
    anthropicCreateMock.mockRejectedValue(outage());

    const refused = await storm(REQUESTS, req());

    // Sem disjuntor seriam 60 requisições (uma por request, sem retry nesta
    // política). Com disjuntor, a carga para na amostra mínima.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(_internal.MIN_SAMPLES);
    expect(refused).toBe(REQUESTS - _internal.MIN_SAMPLES);
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('open');
  });

  it('controle: com a postura `off`, TODAS as 60 requests batem no provider', async () => {
    _internal.setMode('off');
    anthropicCreateMock.mockRejectedValue(outage());

    const refused = await storm(REQUESTS, req());

    expect(anthropicCreateMock).toHaveBeenCalledTimes(REQUESTS);
    expect(refused).toBe(0);
  });

  /**
   * O caso que a issue descreve textualmente: workload com retry E fallback.
   * Cada request custa 2 tentativas no primário + 1 no fast — a carga que o
   * gateway JOGA em cima de um provider já fora é 3× o tráfego de entrada.
   */
  it('workload com retry + fallback: a amplificação de 3× desaparece', async () => {
    _internal.setMode('off');
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(20, req({ workload: 'reasoner' }));
    const withoutBreaker = anthropicCreateMock.mock.calls.length;
    // 20 requests × (2 tentativas + 1 fallback).
    expect(withoutBreaker).toBe(60);

    _internal.reset();
    _internal.setMode('enforce');
    anthropicCreateMock.mockClear();
    await storm(20, req({ workload: 'reasoner' }));
    const withBreaker = anthropicCreateMock.mock.calls.length;

    expect(withBreaker).toBeLessThanOrEqual(_internal.MIN_SAMPLES + 2);
    expect(withBreaker / withoutBreaker).toBeLessThan(0.25);
  }, 20000);

  it('a recusa é um erro próprio, não retentável, e carrega o cooldown restante', async () => {
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(_internal.MIN_SAMPLES, req());

    const err = await executeLLM(req()).catch((e) => e);
    expect(err.kind).toBe('circuit_open');
    expect(err.retryable).toBe(false);
    expect(err.retry_after_ms).toBeGreaterThan(0);
    expect(err.provider).toBe('anthropic');
    expect(err.workload).toBe('role_selector');
    // Nem prompt nem corpo de provider na mensagem.
    expect(err.message).toContain('llm_gateway_circuit_open');
  });

  it('a recusa é observável por tenant, mesmo com o estado sendo global', async () => {
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(_internal.MIN_SAMPLES, req());
    incCounterMock.mockClear();

    await executeLLM(req()).catch(() => undefined);

    expect(counterCalls('maia_llm_requests_total')[0]).toMatchObject({
      tenant_id: 'acme',
      agent_id: 'ana',
      provider: 'anthropic',
      workload: 'role_selector',
      status: 'circuit_open',
    });
  });

  /**
   * O disjuntor recusa ANTES de resolver modelo e reservar cota: uma chamada
   * que não vai acontecer não pode carimbar orçamento nem gastar I/O de Redis.
   */
  it('a recusa não resolve modelo nem toca no orçamento', async () => {
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(_internal.MIN_SAMPLES, req());
    getSettingsMock.mockClear();
    invalidateModelCache();

    await executeLLM(req()).catch(() => undefined);

    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('erro atribuível ao CALLER (400) nunca abre o disjuntor, em nenhum volume', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(400));
    await storm(REQUESTS, req());
    expect(anthropicCreateMock).toHaveBeenCalledTimes(REQUESTS);
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('closed');
  });

  it('401 (chave errada) também não abre — disjuntor não conserta configuração', async () => {
    anthropicCreateMock.mockRejectedValue(apiError(401));
    await storm(REQUESTS, req());
    expect(anthropicCreateMock).toHaveBeenCalledTimes(REQUESTS);
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('closed');
  });

  it('provider que volta: a sonda passa, fecha o disjuntor e o tráfego retoma', async () => {
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(REQUESTS, req());
    const duringOutage = anthropicCreateMock.mock.calls.length;
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('open');

    // Cooldown vencido (o relógio do gateway é real; movemos o estado, não o
    // relógio, para não interferir nos timers do backoff).
    const entry = _internal.circuits.get(JSON.stringify(['anthropic', 'role_selector']))!;
    entry.opened_at -= _internal.OPEN_MS + 1;

    anthropicCreateMock.mockReset();
    anthropicCreateMock.mockResolvedValue(okReply());

    // A sonda passa e fecha o disjuntor…
    const probeRes = await executeLLM(req());
    expect(probeRes.content).toBe('ok');
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('closed');

    // …e o tráfego seguinte volta a fluir normalmente.
    await storm(5, req());
    expect(anthropicCreateMock).toHaveBeenCalledTimes(6);
    expect(duringOutage).toBe(_internal.MIN_SAMPLES);
  });

  it('provider ainda fora: só a janela de sondas sai e o disjuntor reabre', async () => {
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(REQUESTS, req());
    const entry = _internal.circuits.get(JSON.stringify(['anthropic', 'role_selector']))!;
    entry.opened_at -= _internal.OPEN_MS + 1;
    anthropicCreateMock.mockClear();

    await storm(20, req());

    // Só a janela de sondas saiu; o resto foi recusado.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(_internal.HALF_OPEN_MAX_PROBES);
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Tempestade de TIMEOUT do SDK através do gateway real — achado 1 (High) da
// revisão adversarial da PR #541
// ---------------------------------------------------------------------------

/**
 * Este bloco não alimenta `feed('fault')`: ele passa pelo caminho REAL do
 * gateway (`executeLLM` → `provider.call` → `classifyProviderError` →
 * `circuitOutcomeFor` → `releaseCircuit`), que é a única forma de provar as
 * três coisas que a revisão pediu juntas — abertura do circuito, tempo poupado
 * e ausência de retry inesperado. Alimentar o disjuntor direto provaria a
 * aritmética e esconderia justamente o elo defeituoso: a classificação do
 * desfecho no caminho de erro do gateway.
 *
 * O cenário é o da revisão: provider PENDURADO em 70% das chamadas do workload
 * `reasoner`. Cada pendurada custa o timeout inteiro ao caller e mata a chamada
 * na primeira tentativa — sem retry, sem fallback.
 *
 * Antes da correção: `circuitOutcomeFor('timeout') === 'fault'`, a janela
 * media 0.70 por tentativa, o limiar do `reasoner` era `0.5^(1/3) ≈ 0.794`, e
 * o disjuntor ficava FECHADO durante a tempestade inteira. 70% do tráfego se
 * perdia, cada perda pagando o timeout completo, e o controle que existe
 * exatamente para isso não fazia nada.
 */
describe('tempestade de timeout do SDK — `reasoner` (achado 1, PR #541)', () => {
  /** Quanto o provider fica pendurado antes de estourar. É o tempo poupado. */
  const HANG_MS = 20;
  const REQUESTS = 40;
  /** 7 pendurados a cada 10 chamadas = 70% — a taxa do achado. */
  const TIMEOUT_PER_10 = 7;

  let providerCalls = 0;

  /**
   * Timeout como o SDK o entrega: `APIConnectionTimeoutError`. É o que
   * `classifyProviderError` mapeia para `kind: 'timeout'`.
   *
   * NÃO é o deadline do turno: `link.deadlineFired()` continua falso (o
   * `LLM_TURN_DEADLINE_MS` está a 120s daqui), então a distinção que a #534
   * fez na origem — e que a revisão mandou preservar — segue intacta. O que
   * este teste exercita é o outro lado dela: provider pendurado de verdade.
   */
  function sdkTimeout(): Error {
    const err = new Error('Request timed out.');
    err.name = 'APIConnectionTimeoutError';
    return err;
  }

  /** Pendura por `HANG_MS` e só então estoura — o custo que o caller paga. */
  function hangThenTimeout(): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(sdkTimeout()), HANG_MS));
  }

  function installStorm(): void {
    providerCalls = 0;
    anthropicCreateMock.mockImplementation(async () => {
      const hangs = providerCalls++ % 10 < TIMEOUT_PER_10;
      if (hangs) return hangThenTimeout();
      return okReply();
    });
  }

  beforeEach(() => {
    _internal.reset();
    _internal.setMode('enforce');
    anthropicCreateMock.mockReset();
    recordCostMock.mockClear();
    incCounterMock.mockClear();
    observeHistogramMock.mockClear();
    recordCircuitAuditMock.mockClear();
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      main: { value: 'settings-main', source: 'global' },
      fast: { value: 'settings-fast', source: 'global' },
    });
    invalidateModelCache();
  });

  /**
   * A premissa do achado, pinada dos DOIS lados no mesmo teste: o `reasoner`
   * TEM orçamento de 3 tentativas (2 + fallback) para falha retentável, e o
   * timeout NÃO usa nenhuma delas. Sem esta asserção, "1 chamada por request"
   * poderia ser lido como "o workload não tem retry", que é o oposto do ponto.
   */
  it('o `reasoner` gasta 3 tentativas num 5xx e apenas 1 num timeout do SDK', async () => {
    _internal.setMode('off');

    anthropicCreateMock.mockRejectedValue(outage());
    await executeLLM(req({ workload: 'reasoner' })).catch(() => undefined);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(3);

    anthropicCreateMock.mockClear();
    anthropicCreateMock.mockRejectedValue(sdkTimeout());
    const err = await executeLLM(req({ workload: 'reasoner' })).catch((e) => e);
    expect(err.kind).toBe('timeout');
    // TERMINAL: nem retry, nem fallback. É por isso que a matemática de
    // múltiplas tentativas não pode ser aplicada a esta falha.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });

  it('a 70% de timeout terminal o disjuntor ABRE, corta a carga e poupa tempo', async () => {
    // --- controle: postura `off`, a tempestade inteira bate no provider -----
    _internal.setMode('off');
    installStorm();
    const offStarted = Date.now();
    const offRefused = await storm(REQUESTS, req({ workload: 'reasoner' }));
    const offElapsed = Date.now() - offStarted;
    const offCalls = providerCalls;

    // Uma chamada de provider por request — a prova de que o timeout é
    // terminal e NÃO percorre o orçamento de 3 tentativas do workload.
    expect(offCalls).toBe(REQUESTS);
    expect(offRefused).toBe(0);

    // --- disjuntor em vigor -------------------------------------------------
    _internal.reset();
    _internal.setMode('enforce');
    installStorm();
    const onStarted = Date.now();
    const onRefused = await storm(REQUESTS, req({ workload: 'reasoner' }));
    const onElapsed = Date.now() - onStarted;
    const onCalls = providerCalls;

    // Abre assim que a amostra mínima fecha (7 timeouts + 3 sucessos = 10).
    expect(circuitState(KEY)).toBe('open');
    expect(onCalls).toBe(_internal.MIN_SAMPLES);
    expect(onRefused).toBe(REQUESTS - _internal.MIN_SAMPLES);

    // Tempo poupado: em `off` o caller espera o pendurado 28 vezes; com o
    // disjuntor, 7. O corte é estrutural, não estatístico — mas a asserção usa
    // margem larga para não virar teste de relógio.
    expect(onElapsed).toBeLessThan(offElapsed * 0.6);
    expect(offElapsed).toBeGreaterThanOrEqual(HANG_MS * TIMEOUT_PER_10 * (REQUESTS / 10) * 0.8);
  }, 20000);

  it('a recusa da tempestade é `circuit_open`, não `timeout`, e não toca no provider', async () => {
    installStorm();
    await storm(_internal.MIN_SAMPLES, req({ workload: 'reasoner' }));
    expect(circuitState(KEY)).toBe('open');

    const before = providerCalls;
    const err = await executeLLM(req({ workload: 'reasoner' })).catch((e) => e);
    expect(err.kind).toBe('circuit_open');
    expect(err.retryable).toBe(false);
    expect(err.workload).toBe('reasoner');
    // Nenhuma requisição saiu: o caller nem paga o pendurado.
    expect(providerCalls).toBe(before);
  });

  it('a abertura vai para a trilha durável com a evidência da janela', async () => {
    installStorm();
    await storm(_internal.MIN_SAMPLES, req({ workload: 'reasoner' }));

    expect(auditedActions()).toEqual(['llm_circuit_opened']);
    const [, metadata] = recordCircuitAuditMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(metadata).toMatchObject({
      provider: 'anthropic',
      workload: 'reasoner',
      from: 'closed',
      to: 'open',
      reason: 'error_rate_exceeded',
      mode: 'enforce',
      window_total: _internal.MIN_SAMPLES,
      window_terminal_faults: TIMEOUT_PER_10,
    });
  });
});
