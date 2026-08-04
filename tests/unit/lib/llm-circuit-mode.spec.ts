/**
 * Postura do disjuntor (`off | shadow | enforce`) e o kill switch — revisão do
 * owner sobre a issue #534.
 *
 * O arquivo está organizado em torno do requisito que não pode falhar:
 *
 *  1. **`shadow` NUNCA recusa.** Provado por três ângulos independentes, porque
 *     "provavelmente não recusa" não serve: (a) exaustivamente, um caso por
 *     estado alcançável da máquina; (b) por propriedade, com milhares de
 *     sequências pseudoaleatórias de desfechos; (c) ponta a ponta pelo gateway
 *     real, comparando com `off` chamada por chamada.
 *  2. **`shadow` é uma SIMULAÇÃO FIEL do `enforce`.** Mesma sequência de falhas
 *     alimentada nas duas posturas tem que produzir a mesma trajetória de
 *     estados, o mesmo cooldown e o mesmo número de janelas falhadas.
 *  3. **`off` não guarda estado.**
 *  4. **O kill switch é auditável e expira.** Override sem ator ou sem motivo é
 *     RECUSADO, todo uso é contado e logado, e o arrendamento tem teto.
 *
 * O comportamento do `enforce` em si (limiar, janela, sondas, cooldown
 * geométrico) vive em `llm-circuit-breaker.spec.ts` e não é reexaminado aqui.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  anthropicCreateMock,
  getSettingsMock,
  recordCostMock,
  incCounterMock,
  observeHistogramMock,
  setGaugeProviderMock,
} = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  getSettingsMock: vi.fn(),
  recordCostMock: vi.fn(async () => undefined),
  incCounterMock: vi.fn(),
  observeHistogramMock: vi.fn(),
  setGaugeProviderMock: vi.fn(),
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
      LLM_DAILY_BUDGET_USD: 0,
    },
  };
});

import {
  acquireCircuit,
  circuitState,
  peekCircuit,
  releaseCircuit,
  _internal,
} from '@/lib/llm/circuit-breaker.js';
import type { CircuitKey, CircuitOutcome } from '@/lib/llm/circuit-breaker.js';
import {
  CIRCUIT_MODES,
  MAX_OVERRIDE_MS,
  applyCircuitOverride,
  currentOverride,
  effectiveMode,
  handleCircuitOverrideMessage,
  _internal as modeInternal,
} from '@/lib/llm/circuit-mode.js';
import { ENV_CONTRACT } from '@/config/contract.js';
import { executeLLM as executeLLMRaw } from '@/lib/llm/gateway.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import type { LLMGatewayRequest, LLMResponse } from '@/lib/llm/types.js';

/**
 * Os gauges da POSTURA são registrados na PRIMEIRA leitura da postura, uma vez
 * por processo. Provocamos o registro aqui e tiramos o snapshot: o
 * `mockClear()` do `beforeEach` apagaria o registro do histórico do mock antes
 * do primeiro caso rodar.
 */
effectiveMode();
const MODE_GAUGES = new Map<string, () => Promise<number>>(
  setGaugeProviderMock.mock.calls
    .filter((c) => String(c[0]).startsWith('maia_llm_circuit_mode{'))
    .map((c) => [String(c[0]), c[1] as () => Promise<number>]),
);

const KEY: CircuitKey = { provider: 'anthropic', workload: 'reasoner' };
const SINGLE: CircuitKey = { provider: 'anthropic', workload: 'role_selector' };
const T0 = 1_800_000_000_000;

function counterCalls(name: string): Array<Record<string, string>> {
  return incCounterMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, string>);
}

function entryOf(key: CircuitKey) {
  return _internal.circuits.get(JSON.stringify([key.provider, key.workload]));
}

/** Registra N desfechos idênticos, sempre devolvendo a permissão. */
function feed(key: CircuitKey, outcome: CircuitOutcome, n: number, at = T0): void {
  for (let i = 0; i < n; i++) releaseCircuit(acquireCircuit(key, at), outcome, at);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _internal.reset();
  incCounterMock.mockClear();
  setGaugeProviderMock.mockClear();
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});

afterEach(() => {
  warnSpy.mockRestore();
  _internal.reset();
});

// ---------------------------------------------------------------------------
// 0. O default
// ---------------------------------------------------------------------------

describe('postura — default', () => {
  /**
   * A asserção mais importante do arquivo, e a mais curta: o rollout global da
   * #534 passou a ser em SOMBRA. Se alguém inverter isto num refactor, o
   * disjuntor volta a recusar tráfego de produção sem passagem por staging.
   */
  it('o contrato entrega `shadow` quando a variável não vem no ambiente', () => {
    expect(ENV_CONTRACT.LLM_CIRCUIT_MODE.schema.parse(undefined)).toBe('shadow');
  });

  it('as três posturas do contrato são exatamente as da implementação', () => {
    // Toda postura da implementação tem que ser aceita pelo contrato, e o
    // contrato não pode aceitar nenhuma que a implementação não conheça.
    for (const mode of CIRCUIT_MODES) {
      expect(ENV_CONTRACT.LLM_CIRCUIT_MODE.schema.parse(mode)).toBe(mode);
    }
    expect(() => ENV_CONTRACT.LLM_CIRCUIT_MODE.schema.parse('canary')).toThrow();
  });

  it('sem override nem seam, a postura efetiva é a do contrato', () => {
    expect(effectiveMode()).toBe(modeInternal.baselineMode());
  });
});

// ---------------------------------------------------------------------------
// 1. `shadow` nunca recusa
// ---------------------------------------------------------------------------

describe('postura `shadow` — nunca recusa', () => {
  beforeEach(() => _internal.setMode('shadow'));

  /**
   * Exaustivo por ESTADO. A lista cobre todos os pontos em que o `enforce`
   * devolve `allowed: false` — que são, por construção, os únicos lugares onde
   * a sombra poderia errar (ver `refuse()` em `circuit-breaker.ts`).
   */
  it('deixa passar em TODOS os estados em que o enforce recusaria', () => {
    // (a) fechado — trivial, mas serve de linha de base.
    expect(acquireCircuit(KEY, T0).allowed).toBe(true);

    // (b) aberto com cooldown correndo: o enforce recusa aqui.
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    expect(circuitState(KEY)).toBe('open');
    for (let i = 0; i < 25; i++) {
      const permit = acquireCircuit(KEY, T0 + 1_000);
      expect(permit.allowed, `aberto, tentativa ${i}`).toBe(true);
      expect(permit.allowed && permit.would_reject).toBe(true);
      releaseCircuit(permit, 'fault', T0 + 1_000);
    }

    // (c) half-open com a janela de sondas ESGOTADA: o enforce recusa aqui.
    const at = T0 + _internal.OPEN_MS;
    for (let i = 0; i < _internal.HALF_OPEN_MAX_PROBES; i++) {
      const probe = acquireCircuit(KEY, at);
      expect(probe.allowed && probe.probe, `sonda ${i}`).toBe(true);
    }
    expect(circuitState(KEY)).toBe('half_open');
    for (let i = 0; i < 25; i++) {
      const permit = acquireCircuit(KEY, at);
      expect(permit.allowed, `half-open esgotado, tentativa ${i}`).toBe(true);
      expect(permit.allowed && permit.would_reject).toBe(true);
    }
  });

  it('o peek também deixa passar, marcando `would_reject`', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    const peek = peekCircuit(KEY, T0 + 1_000);
    expect(peek.allowed).toBe(true);
    expect(peek.would_reject).toBe(true);
    expect(peek.state).toBe('open');
  });

  /**
   * Por PROPRIEDADE. A prova exaustiva acima depende de eu ter enumerado os
   * estados certos; esta não depende de nada além do invariante. Sequências
   * pseudoaleatórias de desfechos e de saltos de relógio, e uma única asserção:
   * jamais `allowed === false`.
   */
  it('propriedade: nenhuma sequência de desfechos produz uma recusa', () => {
    let seed = 0x5eed;
    const rand = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const outcomes: CircuitOutcome[] = ['ok', 'fault', 'ignored'];

    let now = T0;
    let refusals = 0;
    for (let i = 0; i < 20_000; i++) {
      // Salta o relógio de vez em quando: é o que faz o cooldown vencer, a
      // janela caducar e o half-open acontecer de verdade dentro do loop.
      if (rand() < 0.05) now += Math.floor(rand() * (_internal.MAX_OPEN_MS + 1));
      else now += Math.floor(rand() * 50);

      const key = rand() < 0.5 ? KEY : SINGLE;
      const permit = acquireCircuit(key, now);
      if (!permit.allowed) refusals++;
      else releaseCircuit(permit, outcomes[Math.floor(rand() * 3)]!, now);
    }
    expect(refusals).toBe(0);
    // Sanidade: se a máquina nunca tivesse aberto, a propriedade seria vazia.
    expect(counterCalls('maia_llm_circuit_would_open_total').length).toBeGreaterThan(0);
  });

  it('nunca emite `short_circuited` — em sombra nada é cortado de verdade', () => {
    feed(KEY, 'fault', _internal.MIN_SAMPLES * 3, T0);
    for (let i = 0; i < 20; i++) acquireCircuit(KEY, T0 + 1_000);
    expect(counterCalls('maia_llm_circuit_short_circuited_total')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. `shadow` simula `enforce` fielmente
// ---------------------------------------------------------------------------

describe('postura `shadow` — fidelidade da simulação', () => {
  /**
   * Roda a MESMA sequência de desfechos nas duas posturas e devolve a
   * trajetória de estados. Em `shadow` as chamadas que o `enforce` teria
   * recusado ainda acontecem (é o que a sombra faz), e o desfecho delas é
   * descartado — que é justamente o que mantém as duas trajetórias iguais.
   */
  function trajectory(mode: 'shadow' | 'enforce', script: Array<[CircuitOutcome, number]>) {
    _internal.reset();
    _internal.setMode(mode);
    const states: string[] = [];
    for (const [outcome, dt] of script) {
      const at = T0 + dt;
      const permit = acquireCircuit(KEY, at);
      if (permit.allowed) releaseCircuit(permit, outcome, at);
      states.push(circuitState(KEY));
    }
    const entry = entryOf(KEY);
    return {
      states,
      cooldown_ms: entry?.cooldown_ms,
      failed_windows: entry?.failed_windows,
      samples: entry?.samples.length,
    };
  }

  it('a trajetória de estados é IDÊNTICA à do enforce sob a mesma carga', () => {
    const script: Array<[CircuitOutcome, number]> = [];
    // Queda: abre.
    for (let i = 0; i < 15; i++) script.push(['fault', i * 10]);
    // Cooldown correndo — o enforce recusa tudo aqui; a sombra deixa passar e
    // DESCARTA o desfecho. Se descartasse errado, as trajetórias divergiriam.
    for (let i = 0; i < 30; i++) script.push(['fault', 200 + i * 10]);
    // Cooldown vence: janela de sondas que falha inteira, reabre com o dobro.
    for (let i = 0; i < 5; i++) script.push(['fault', _internal.OPEN_MS + 100 + i]);
    // Segundo cooldown vence e uma sonda passa: fecha.
    for (let i = 0; i < 4; i++) script.push(['ok', _internal.OPEN_MS * 4 + i]);

    const shadow = trajectory('shadow', script);
    const enforce = trajectory('enforce', script);

    expect(shadow.states).toEqual(enforce.states);
    expect(shadow.cooldown_ms).toBe(enforce.cooldown_ms);
    expect(shadow.failed_windows).toBe(enforce.failed_windows);
    expect(shadow.samples).toBe(enforce.samples);
  });

  /**
   * O mecanismo por trás da fidelidade, isolado: a chamada que só aconteceu
   * porque estávamos em sombra não pode virar amostra. Se virasse, a janela do
   * `open` ficaria eternamente cheia de falhas que o disjuntor real nunca teria
   * visto — ou, pior, "curada" por sucessos que ele também não teria visto.
   */
  it('o desfecho de uma chamada que o enforce teria recusado NÃO entra na janela', () => {
    _internal.setMode('shadow');
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    const before = entryOf(KEY)!.samples.length;

    for (let i = 0; i < 50; i++) {
      const permit = acquireCircuit(KEY, T0 + 1_000);
      expect(permit.allowed && permit.would_reject).toBe(true);
      releaseCircuit(permit, i % 2 === 0 ? 'ok' : 'fault', T0 + 1_000);
    }

    expect(entryOf(KEY)!.samples.length).toBe(before);
    expect(circuitState(KEY)).toBe('open');
  });

  it('a sonda de half-open é concedida e CONTA nas duas posturas', () => {
    _internal.setMode('shadow');
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    const probe = acquireCircuit(KEY, T0 + _internal.OPEN_MS);
    expect(probe.allowed && probe.probe).toBe(true);
    // Sonda nunca é `would_reject`: é ela que decide fechar ou reabrir.
    expect(probe.allowed && probe.would_reject).toBe(false);
    releaseCircuit(probe, 'ok', T0 + _internal.OPEN_MS);
    expect(circuitState(KEY)).toBe('closed');
  });

  it('`would_open` sai em sombra, e NÃO sai em enforce', () => {
    _internal.setMode('shadow');
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    expect(counterCalls('maia_llm_circuit_would_open_total')[0]).toMatchObject({
      provider: 'anthropic',
      workload: 'reasoner',
      reason: 'error_rate_exceeded',
    });

    _internal.reset();
    _internal.setMode('enforce');
    incCounterMock.mockClear();
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    expect(counterCalls('maia_llm_circuit_would_open_total')).toHaveLength(0);
    // A transição real continua saindo nas duas — é a mesma máquina.
    expect(counterCalls('maia_llm_circuit_transitions_total')[0]).toMatchObject({
      state: 'open',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. `off` não guarda estado
// ---------------------------------------------------------------------------

describe('postura `off`', () => {
  it('não cria entrada, não registra gauge e não guarda amostra', () => {
    _internal.setMode('off');
    setGaugeProviderMock.mockClear();
    feed(KEY, 'fault', _internal.MIN_SAMPLES * 5, T0);
    expect(_internal.circuits.size).toBe(0);
    expect(circuitState(KEY)).toBe('closed');
    expect(
      setGaugeProviderMock.mock.calls.filter((c) => String(c[0]).startsWith('maia_llm_circuit_state')),
    ).toHaveLength(0);
  });

  it('entrar em `off` DESCARTA o estado acumulado', () => {
    _internal.setMode('enforce');
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    expect(circuitState(KEY)).toBe('open');

    _internal.setMode('off');
    // A borda é detectada na primeira leitura da postura.
    expect(effectiveMode()).toBe('off');
    expect(_internal.circuits.size).toBe(0);

    // E ao religar, começa fechado: um `open` de ontem não pode voltar
    // recusando tráfego saudável no instante em que o operador reverte.
    _internal.setMode('enforce');
    expect(circuitState(KEY)).toBe('closed');
  });

  it('a série de estado vira NaN (amostra ausente), nunca 0', async () => {
    _internal.setMode('enforce');
    acquireCircuit(KEY, T0);
    const series =
      'maia_llm_circuit_state{provider="anthropic",state="closed",workload="reasoner"}';
    const provider = setGaugeProviderMock.mock.calls
      .filter((c) => c[0] === series)
      .pop()?.[1] as () => Promise<number>;
    expect(await provider()).toBe(1);

    _internal.setMode('off');
    // `0` mentiria dizendo "fechado e saudável" sobre um disjuntor que não está
    // observando coisa alguma; NaN o Prometheus trata como amostra ausente.
    expect(await provider()).toBeNaN();
  });

  it('devolver uma permissão obtida antes do desligamento é inofensivo', () => {
    _internal.setMode('enforce');
    const permit = acquireCircuit(KEY, T0);
    _internal.setMode('off');
    expect(() => releaseCircuit(permit, 'fault', T0)).not.toThrow();
    expect(_internal.circuits.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Kill switch
// ---------------------------------------------------------------------------

describe('kill switch — override de postura', () => {
  const ACTOR = 'sre:diogenes';
  const REASON = 'incidente-4412: disjuntor abrindo em brownout';

  function overrideCalls(): Array<Record<string, string>> {
    return counterCalls('maia_llm_circuit_mode_overrides_total');
  }

  it('força `off` sem restart e vence a postura do contrato', () => {
    expect(effectiveMode(T0)).toBe(modeInternal.baselineMode());
    const res = applyCircuitOverride(
      { mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 },
      T0,
    );
    expect(res.applied).toBe(true);
    expect(effectiveMode(T0)).toBe('off');
    expect(currentOverride(T0)).toMatchObject({ mode: 'off', actor: ACTOR, reason: REASON });
  });

  /**
   * A objeção original da #534 ao toggle de runtime era "alguém vira às 3h da
   * manhã sem deixar rastro". Esta é a resposta: não existe caminho para virar
   * a chave sem se identificar e sem dizer por quê.
   */
  it('RECUSA override sem ator ou sem motivo', () => {
    expect(applyCircuitOverride({ mode: 'off', reason: REASON }, T0).applied).toBe(false);
    expect(applyCircuitOverride({ mode: 'off', actor: ACTOR }, T0).applied).toBe(false);
    expect(applyCircuitOverride({ mode: 'off', actor: '  ', reason: '  ' }, T0).applied).toBe(false);
    expect(effectiveMode(T0)).toBe(modeInternal.baselineMode());
    expect(overrideCalls().every((c) => c.reason === 'rejected')).toBe(true);
  });

  it('RECUSA postura inexistente e arrendamento acima do teto', () => {
    expect(applyCircuitOverride({ mode: 'nope', actor: ACTOR, reason: REASON }, T0).applied).toBe(
      false,
    );
    expect(
      applyCircuitOverride(
        { mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: MAX_OVERRIDE_MS + 1 },
        T0,
      ).applied,
      // Truncar em silêncio seria pior: o operador precisa saber que o
      // arrendamento que ele pediu não é o que ficou valendo.
    ).toBe(false);
    expect(effectiveMode(T0)).toBe(modeInternal.baselineMode());
  });

  it('EXPIRA sozinho e volta para a postura versionada, contando o retorno', () => {
    applyCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }, T0);
    expect(effectiveMode(T0 + 59_999)).toBe('off');
    incCounterMock.mockClear();

    expect(effectiveMode(T0 + 60_001)).toBe(modeInternal.baselineMode());
    expect(overrideCalls()).toContainEqual(
      expect.objectContaining({ state: 'off', reason: 'expired' }),
    );
    expect(currentOverride(T0 + 60_001)).toBeNull();
  });

  it('`clear` devolve o controle ao contrato na hora', () => {
    applyCircuitOverride({ mode: 'enforce', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }, T0);
    expect(effectiveMode(T0)).toBe('enforce');
    applyCircuitOverride({ clear: true, actor: ACTOR, reason: 'incidente encerrado' }, T0);
    expect(effectiveMode(T0)).toBe(modeInternal.baselineMode());
    expect(overrideCalls()).toContainEqual(expect.objectContaining({ reason: 'cleared' }));
  });

  it('todo uso vira contador E log estruturado com ator e motivo', () => {
    applyCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }, T0);
    expect(overrideCalls()).toContainEqual(
      expect.objectContaining({ state: 'off', reason: 'applied' }),
    );
    const line = warnSpy.mock.calls.find((c) => c[1] === 'llm_gateway.circuit_mode_override');
    expect(line, 'o uso do kill switch tem que aparecer no log').toBeTruthy();
    // Ator e motivo são texto livre do operador: vivem no log (sem
    // cardinalidade), NUNCA em label.
    expect(line![0]).toMatchObject({ action: 'applied', mode: 'off', actor: ACTOR, reason: REASON });
    // Mudar a postura é evento de FROTA, não de tenant: o contador não carrega
    // atribuição (seria a do ALS que por acaso estava ativo, que não diz nada),
    // e ator/motivo são texto livre — log, nunca label.
    for (const labels of overrideCalls()) {
      expect(Object.keys(labels).sort()).toEqual(['reason', 'state']);
    }
  });

  it('a postura efetiva é um par de séries, exatamente uma valendo 1', async () => {
    applyCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }, T0);
    const on: string[] = [];
    for (const mode of CIRCUIT_MODES) {
      const provider = MODE_GAUGES.get(`maia_llm_circuit_mode{state="${mode}"}`);
      expect(provider, `série ${mode} não registrada`).toBeTypeOf('function');
      if ((await provider!()) === 1) on.push(mode);
    }
    expect(on).toEqual(['off']);
  });

  it('o payload do canal é parseado, e lixo é recusado sem lançar', () => {
    expect(
      handleCircuitOverrideMessage(
        JSON.stringify({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }),
        T0,
      ).applied,
    ).toBe(true);
    expect(effectiveMode(T0)).toBe('off');

    expect(handleCircuitOverrideMessage('não é json', T0).applied).toBe(false);
    expect(handleCircuitOverrideMessage('42', T0).applied).toBe(false);
    // Lixo não derruba o override legítimo que já estava valendo.
    expect(effectiveMode(T0)).toBe('off');
  });

  /**
   * Um pub/sub perde mensagem para quem não estava inscrito na hora. Sem a
   * adoção da chave durável, um deploy no meio do incidente traria réplicas
   * novas com o disjuntor de volta na postura do contrato — metade da frota
   * recusando e metade não.
   */
  it('adota um `expires_at` absoluto, herdando o resto do arrendamento', () => {
    const res = applyCircuitOverride(
      { mode: 'off', actor: ACTOR, reason: REASON, expires_at: T0 + 10_000 },
      T0 + 9_000,
      'adopted',
    );
    expect(res.applied).toBe(true);
    expect(effectiveMode(T0 + 9_500)).toBe('off');
    expect(effectiveMode(T0 + 10_001)).toBe(modeInternal.baselineMode());
    expect(overrideCalls()).toContainEqual(
      expect.objectContaining({ state: 'off', reason: 'adopted' }),
    );
  });

  it('o override efetivamente muda o comportamento do disjuntor', () => {
    applyCircuitOverride({ mode: 'enforce', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }, T0);
    feed(KEY, 'fault', _internal.MIN_SAMPLES, T0);
    expect(acquireCircuit(KEY, T0 + 1).allowed).toBe(false);

    applyCircuitOverride({ mode: 'off', actor: ACTOR, reason: 'kill switch', ttl_ms: 60_000 }, T0);
    expect(acquireCircuit(KEY, T0 + 2).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Ponta a ponta pelo gateway real
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

function outage() {
  const err = new Error('boom') as Error & { status: number; headers: Record<string, string> };
  err.status = 503;
  err.headers = { 'retry-after': '0.01' };
  return err;
}

function okReply() {
  return {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

type StormResult = { ok: number; refused: number; failed: number };

async function storm(n: number, request: LLMGatewayRequest): Promise<StormResult> {
  const out: StormResult = { ok: 0, refused: 0, failed: 0 };
  for (let i = 0; i < n; i++) {
    await executeLLM(request).then(
      () => out.ok++,
      (e: { kind?: string }) => {
        if (e.kind === 'circuit_open') out.refused++;
        else out.failed++;
      },
    );
  }
  return out;
}

describe('gateway — `shadow` não muda nada do que o caller vê', () => {
  beforeEach(() => {
    _internal.reset();
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

  /**
   * O bug imperdoável do shadow seria transformar uma chamada que teria dado
   * certo num erro. Aqui o provider está SAUDÁVEL: qualquer recusa, qualquer
   * erro, é o bug.
   */
  it('provider saudável: nenhuma chamada é recusada nem falha', async () => {
    _internal.setMode('shadow');
    anthropicCreateMock.mockResolvedValue(okReply());

    const res = await storm(REQUESTS, req());

    expect(res).toEqual({ ok: REQUESTS, refused: 0, failed: 0 });
    expect(anthropicCreateMock).toHaveBeenCalledTimes(REQUESTS);
    expect(counterCalls('maia_llm_circuit_would_reject_total')).toHaveLength(0);
  });

  /**
   * O caso difícil: provider FORA e o disjuntor de sombra ABERTO. É onde o
   * `enforce` recusaria, e é exatamente onde a sombra tem que continuar
   * deixando passar — os desfechos precisam bater, chamada por chamada, com a
   * postura `off`.
   */
  it('provider fora: sombra entrega os MESMOS desfechos que `off`', async () => {
    _internal.setMode('off');
    anthropicCreateMock.mockRejectedValue(outage());
    const withoutBreaker = await storm(REQUESTS, req());
    const callsOff = anthropicCreateMock.mock.calls.length;

    _internal.reset();
    _internal.setMode('shadow');
    anthropicCreateMock.mockClear();
    const withShadow = await storm(REQUESTS, req());

    expect(withShadow).toEqual(withoutBreaker);
    expect(withShadow.refused).toBe(0);
    expect(anthropicCreateMock.mock.calls.length).toBe(callsOff);
    // …e o disjuntor DE SOMBRA abriu de verdade: a igualdade acima não é o
    // resultado trivial de a máquina nunca ter saído de `closed`.
    expect(circuitState({ provider: 'anthropic', workload: 'role_selector' })).toBe('open');
  });

  it('e a mesma carga em `enforce` recusa — a diferença é só a postura', async () => {
    _internal.setMode('enforce');
    anthropicCreateMock.mockRejectedValue(outage());
    const res = await storm(REQUESTS, req());
    expect(res.refused).toBe(REQUESTS - _internal.MIN_SAMPLES);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(_internal.MIN_SAMPLES);
  });

  /**
   * `would_reject` é o gêmeo de `maia_llm_requests_total{status="circuit_open"}`
   * e precisa ser contado UMA VEZ POR CHAMADA. Num workload com retry e
   * fallback, contar por tentativa inflaria a sombra em ~4× e destruiria a
   * comparação, que é a única razão de a métrica existir.
   */
  it('`would_reject` é uma vez por CHAMADA, não por tentativa', async () => {
    _internal.setMode('shadow');
    anthropicCreateMock.mockRejectedValue(outage());
    // Abre o disjuntor de sombra num workload com 2 tentativas + fallback.
    await storm(10, req({ workload: 'reasoner' }));
    expect(circuitState({ provider: 'anthropic', workload: 'reasoner' })).toBe('open');
    incCounterMock.mockClear();

    await storm(5, req({ workload: 'reasoner' }));

    const rejects = counterCalls('maia_llm_circuit_would_reject_total');
    expect(rejects).toHaveLength(5);
    expect(anthropicCreateMock.mock.calls.length).toBeGreaterThan(5);
  });

  /**
   * AGENTS.md §4.1: o estado do disjuntor é global de propósito, mas toda
   * recusa — real ou simulada — continua atribuível a quem a comeu.
   */
  it('`would_reject` carrega tenant_id + agent_id, como a recusa real', async () => {
    _internal.setMode('shadow');
    anthropicCreateMock.mockRejectedValue(outage());
    await storm(_internal.MIN_SAMPLES + 2, req());
    incCounterMock.mockClear();

    await runWithTenantContext({ tenant_id: 'outra', agent_id: 'bia' }, () =>
      executeLLMRaw(req()).catch(() => undefined),
    );

    expect(counterCalls('maia_llm_circuit_would_reject_total')[0]).toMatchObject({
      tenant_id: 'outra',
      agent_id: 'bia',
      provider: 'anthropic',
      workload: 'role_selector',
      state: 'open',
    });
  });

  it('`off` pelo gateway: nenhuma recusa e nenhum estado guardado', async () => {
    _internal.setMode('off');
    anthropicCreateMock.mockRejectedValue(outage());
    const res = await storm(REQUESTS, req());
    expect(res.refused).toBe(0);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(REQUESTS);
    expect(_internal.circuits.size).toBe(0);
    expect(counterCalls('maia_llm_circuit_would_reject_total')).toHaveLength(0);
  });
});
