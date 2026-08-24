/**
 * Issue #535 §1 — o span `llm.request`.
 *
 * A #535 abre reclamando que a taxonomia DECLARA uma árvore que ninguém
 * emite. `llm.request` era a ausência mais cara da lista: a chamada de modelo
 * domina a latência do turno, então um waterfall sem ela responde "o turno foi
 * lento" e não "o turno foi lento AQUI", que é a única pergunta que o trace
 * existe para responder.
 *
 * ## O que esta suíte prova, e por que dessa forma
 *
 * A prova entra pelo `executeLLM` REAL (`src/lib/llm/gateway.ts`) — o mesmo
 * ponto que `src/agent/react-loop.ts` chama via `callLLM` em todo turno — e
 * sai pelo TRANSPORTE OTLP real, montado por `startOtlpExporter`. Nada entre
 * as duas pontas é encenado pelo teste: o único stub é o SDK do provider (a
 * rede) e o `pg` do ledger de custo.
 *
 * Isso é o equivalente, para a superfície de trace, do que a base já exige
 * para métrica ("raspar o `/metrics` real e procurar a série pelo NOME"):
 * o corpo POSTado para o collector é raspado e o span é procurado pelo nome
 * `llm.request`. Um teste que chamasse `recordLlmRequestSpan` diretamente
 * provaria que a função existe — e continuaria verde com a chamada removida
 * de `emitUsage`, que é exatamente o defeito que importa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  endpoint: 'http://collector:4318/v1/traces' as string | undefined,
  ratio: 1,
  strict: false,
}));

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
  setGaugeProvider: vi.fn(),
}));

vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  const overrides: Record<string, unknown> = {
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
    OPENROUTER_API_KEY: 'sk-or-test-placeholder',
    CLAUDE_MAX_RETRIES: 2,
    CLAUDE_TIMEOUT_MS: 30000,
    CLAUDE_MODEL_MAIN: 'env-main',
    CLAUDE_MODEL_FAST: 'env-fast',
  };
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        if (prop === 'MAIA_STRICT_METRIC_LABELS') return cfg.strict;
        if (prop in overrides) return overrides[prop as string];
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import { executeLLM } from '@/lib/llm/gateway.js';
import { _internal as circuitInternal } from '@/lib/llm/circuit-breaker.js';
import { invalidateModelCache } from '@/lib/llm/model-resolver.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithCorrelation } from '@/observability/correlation.js';
import { recordLlmRequestSpan } from '@/observability/instrumentation.js';
import {
  startOtlpExporter,
  stopOtlpExporter,
  type OtlpTransportResult,
} from '@/observability/otlp-exporter.js';
import { isDeclaredAncestor, withSpan } from '@/observability/tracer.js';
import { SPAN, SPAN_EMISSION } from '@/observability/taxonomy.js';
import type { LLMGatewayRequest } from '@/lib/llm/types.js';

const TURN_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SCOPE = { tenant_id: 'acme', agent_id: 'ana' };

/**
 * O que o collector realmente recebeu. Guardamos o corpo CRU (a string
 * POSTada) e a versão decodificada: a primeira é o que prova que o span
 * atravessou a codificação OTLP inteira, a segunda é o que deixa a asserção
 * legível.
 */
interface OtlpSpanOnWire {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number };
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
}

let wire: string[] = [];

function spansOnWire(): OtlpSpanOnWire[] {
  return wire.flatMap((body) => {
    const parsed = JSON.parse(body) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpanOnWire[] }> }>;
    };
    return parsed.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
  });
}

function attr(span: OtlpSpanOnWire, key: string): unknown {
  const found = span.attributes.find((a) => a.key === key);
  if (!found) return undefined;
  return Object.values(found.value)[0];
}

const captureTransport = async (
  _endpoint: string,
  _headers: Record<string, string>,
  body: string,
): Promise<OtlpTransportResult> => {
  wire.push(body);
  return { ok: true, status: 200 };
};

function okReply(text = 'ok') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function apiError(status: number, message = 'boom') {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
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

/**
 * Um turno, como produção o executa: correlação aberta, span-raiz `turn`
 * aberto, escopo de tenant resolvido, e a chamada de modelo lá dentro.
 */
async function inATurn<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCorrelation({ trace_id: TURN_UUID }, () =>
    withSpan(SPAN.TURN, () => runWithTenantContext(SCOPE, fn)),
  );
}

beforeEach(async () => {
  wire = [];
  cfg.endpoint = 'http://collector:4318/v1/traces';
  cfg.ratio = 1;
  cfg.strict = false;
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
  circuitInternal.reset();
  await stopOtlpExporter();
  startOtlpExporter({
    endpoint: cfg.endpoint,
    transport: captureTransport,
    // Sem timer: o teste dá o flush. Um intervalo vivo aqui só criaria
    // corrida entre a asserção e o tick.
    scheduledDelayMs: 3_600_000,
  });
});

afterEach(async () => {
  await stopOtlpExporter();
});

describe('issue #535 §1 — llm.request chega ao collector pelo caminho real', () => {
  it('uma chamada bem-sucedida do executeLLM REAL produz o span no corpo OTLP', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());

    await inATurn(() => executeLLM(req({ tier: 'main' })));
    await stopOtlpExporter();

    // Procurado pelo NOME no que foi POSTado, não num objeto que o teste
    // montou: é o que reprova se `emitUsage` parar de emitir.
    expect(wire.join('')).toContain('"name":"llm.request"');

    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST);
    expect(span, 'nenhum span llm.request no corpo OTLP').toBeDefined();
    expect(attr(span!, 'result')).toBe('ok');
    expect(attr(span!, 'status')).toBe('ok');
    expect(attr(span!, 'provider')).toBe('anthropic');
    expect(attr(span!, 'model')).toBe('settings-main');
    expect(attr(span!, 'workload')).toBe('reasoner');
    expect(attr(span!, 'tier')).toBe('main');
    // OTLP: 1 = OK.
    expect(span!.status.code).toBe(1);
  });

  it('herda o trace id do turno e pendura no span-raiz aberto', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());

    await inATurn(() => executeLLM(req()));
    await stopOtlpExporter();

    const spans = spansOnWire();
    const llm = spans.find((s) => s.name === SPAN.LLM_REQUEST);
    const turn = spans.find((s) => s.name === SPAN.TURN);
    expect(llm?.traceId).toBe('550e8400e29b41d4a716446655440000');
    expect(llm?.traceId).toBe(turn?.traceId);
    // `llm.request` declara `react.iteration` como pai, que ainda não tem
    // emissor — então em runtime ele se prende ao ancestral que ESTÁ aberto.
    // Continua tendo de ser um ancestral DECLARADO, não um span qualquer.
    expect(llm?.parentSpanId).toBe(turn?.spanId);
    expect(isDeclaredAncestor(SPAN.LLM_REQUEST, SPAN.TURN)).toBe(true);
    expect(isDeclaredAncestor(SPAN.TURN, SPAN.LLM_REQUEST)).toBe(false);
  });

  it('o desfecho de FALHA também emite — o span não é privilégio do caminho feliz', async () => {
    // 401 é terminal no gateway (não retenta), então o turno termina em erro
    // sem passar pelo caminho de sucesso em nenhum momento.
    anthropicCreateMock.mockRejectedValueOnce(apiError(401, 'unauthorized'));

    await expect(inATurn(() => executeLLM(req()))).rejects.toThrow();
    await stopOtlpExporter();

    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST);
    expect(span, 'falha do provider não produziu span').toBeDefined();
    expect(attr(span!, 'result')).toBe('error');
    // OTLP: 2 = ERROR.
    expect(span!.status.code).toBe(2);
  });

  it('a recusa por FALTA DE CONTEXTO DE TENANT emite antes de qualquer I/O', async () => {
    // Este é o desfecho mais fácil de perder: `executeLLM` sai por `throw`
    // antes de tocar o provider. Se o span estivesse amarrado ao caminho da
    // chamada em vez de ao ponto único de telemetria, sumiria aqui.
    await runWithCorrelation({ trace_id: TURN_UUID }, () =>
      withSpan(SPAN.TURN, async () => {
        await expect(executeLLM(req())).rejects.toThrow(/tenant_id/);
      }),
    );
    await stopOtlpExporter();

    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST);
    expect(span, 'recusa por escopo ausente não produziu span').toBeDefined();
    expect(attr(span!, 'result')).toBe('error');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('a duração do span é a MESMA medição que o histograma publica', async () => {
    anthropicCreateMock.mockResolvedValueOnce(okReply());

    await inATurn(() => executeLLM(req()));
    await stopOtlpExporter();

    const observed = observeHistogramMock.mock.calls.find(
      (c) => c[0] === 'maia_llm_request_duration_ms',
    );
    expect(observed, 'histograma de duração não foi emitido').toBeDefined();

    // A janela é RECONSTRUÍDA a partir de `duration_ms` — a mesma medição que
    // o histograma publica —, então span e histograma não podem divergir por
    // construção. É isso que a largura do span provou.
    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST)!;
    const widthMs = Number(
      (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n,
    );
    expect(widthMs).toBe(Math.max(0, Number(observed![1])));
  });
});

describe('issue #535 §1 — o span é observação pura', () => {
  it('com tracing DESLIGADO a chamada segue idêntica e nada é exportado', async () => {
    cfg.endpoint = undefined;
    anthropicCreateMock.mockResolvedValueOnce(okReply());

    const res = await inATurn(() => executeLLM(req()));
    await stopOtlpExporter();

    expect(res.content).toBe('ok');
    expect(wire).toEqual([]);
  });

  it('SPAN_EMISSION marca llm.request como emitido', () => {
    expect(SPAN_EMISSION[SPAN.LLM_REQUEST]).toBe('emitted');
  });
});

describe('issue #535 §1 — vocabulário fechado e cardinalidade', () => {
  /**
   * O mapeamento é um `Record` TOTAL sobre `LLMCallStatus`: sete valores do
   * gateway colapsam nos cinco do `SpanStatus`. As duas linhas que colapsam
   * são decisão, não acaso — "nós recusamos" (`blocked`) não pode virar "a
   * plataforma quebrou" (`error`), que é a distinção que a #534 criou o
   * status `circuit_open` para preservar.
   *
   * Exercitado pela função de PRODUÇÃO (a mesma que `emitUsage` chama), com o
   * desfecho variando — não por uma tabela copiada para o teste.
   */
  it.each([
    ['ok', 1, 'ok'],
    ['error', 2, 'error'],
    ['timeout', 2, 'timeout'],
    ['rate_limit', 2, 'error'],
    ['cancelled', 2, 'cancelled'],
    ['budget_exhausted', 2, 'blocked'],
    ['circuit_open', 2, 'blocked'],
  ] as const)(
    'status %s do gateway vira código OTLP %i e status de span %s',
    async (status, code, spanStatus) => {
      await runWithCorrelation({ trace_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, async () =>
          runWithTenantContext(SCOPE, async () => {
            recordLlmRequestSpan({
              duration_ms: 12,
              status,
              provider: 'anthropic',
              model: 'settings-main',
              tier: 'main',
              workload: 'reasoner',
              attempts: 1,
              observed_at_ms: Date.now(),
            });
          }),
        ),
      );
      await stopOtlpExporter();

      const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST)!;
      expect(span.status.code).toBe(code);
      expect(attr(span, 'status')).toBe(spanStatus);
      // O vocabulário de SETE valores sobrevive verbatim no `result`: o
      // colapso é do código OTLP, nunca da evidência.
      expect(attr(span, 'result')).toBe(status);
    },
  );

  it('não sobrescreve o `attempt` do turno com as tentativas do provider', async () => {
    // `attempt` é o índice de retry do TURNO, carimbado em todo span por
    // `correlationAttributes()`. As tentativas do provider viajam em
    // `attempt_count`. Trocar as duas tornaria um turno retentado impossível
    // de agrupar no collector — a pendência herdada que a #535 lista.
    //
    // Valores diferentes de propósito (3 vs 1): se as chaves colidissem, um
    // dos dois sumiria do corpo OTLP e a asserção reprovaria.
    anthropicCreateMock.mockResolvedValueOnce(okReply());

    await runWithCorrelation({ trace_id: TURN_UUID, attempt: 3 }, () =>
      withSpan(SPAN.TURN, () => runWithTenantContext(SCOPE, () => executeLLM(req()))),
    );
    await stopOtlpExporter();

    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST)!;
    // `intValue` é STRING no mapeamento protobuf-JSON (int64 estoura o
    // alcance exato do IEEE-754) — é o que `encodeSpans` produz e o que o
    // collector exige.
    expect(attr(span, 'attempt')).toBe('3');
    expect(attr(span, 'attempt_count')).toBe('1');
  });

  it('um valor de atributo fora da forma segura é sanitizado, nunca exportado', async () => {
    // Um `model` vindo de configuração errada (ou de um provider hostil) não
    // pode virar payload no collector de terceiro. O portão de atributo roda
    // no FIM do span, antes da fila do exporter.
    await runWithCorrelation({ trace_id: TURN_UUID }, () =>
      withSpan(SPAN.TURN, async () =>
        runWithTenantContext(SCOPE, async () => {
          recordLlmRequestSpan({
            duration_ms: 5,
            status: 'ok',
            provider: 'anthropic',
            model: '+55 11 98765-4321',
            tier: 'main',
            workload: 'reasoner',
            attempts: 1,
            observed_at_ms: Date.now(),
          });
        }),
      ),
    );
    await stopOtlpExporter();

    const body = wire.join('');
    expect(body).not.toContain('98765');
    const span = spansOnWire().find((s) => s.name === SPAN.LLM_REQUEST)!;
    expect(attr(span, 'model')).toBe('__sanitized__');
  });

  it('em MAIA_STRICT_METRIC_LABELS a violação reprova em vez de vazar', async () => {
    cfg.strict = true;
    await expect(
      runWithCorrelation({ trace_id: TURN_UUID }, () =>
        withSpan(SPAN.TURN, async () =>
          runWithTenantContext(SCOPE, async () => {
            recordLlmRequestSpan({
              duration_ms: 5,
              status: 'ok',
              provider: 'anthropic',
              model: 'alguem@example.com',
              tier: 'main',
              workload: 'reasoner',
              attempts: 1,
              observed_at_ms: Date.now(),
            });
          }),
        ),
      ),
    ).rejects.toThrow(/disallowed attributes/);
  });
});
