/**
 * Issue #535 §2 — a FIAÇÃO de `instrumentToolDispatch`, não o wrapper.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A lacuna que este arquivo fecha
 * ─────────────────────────────────────────────────────────────────────────
 * `tests/unit/observability/instrumentation.spec.ts` chama
 * `instrumentToolDispatch()` diretamente e cobre bem o que ele faz: classifica
 * `{ error }` em `ok`/`blocked`/`invalid`/`error`, conta, mede e abre o span.
 * Apague a linha `counter()` de DENTRO dele e aquele arquivo fica vermelho em
 * 4 casos. O que nada segurava é que PRODUÇÃO ainda o chama.
 *
 * Medido: trocar, em `src/tools/_dispatcher.ts`,
 *
 *     return instrumentToolDispatch(input.tool, () => dispatchToolInner(input));
 *
 * por
 *
 *     return dispatchToolInner(input);
 *
 * deixa 1315 testes verdes — `tests/unit/observability` inteiro,
 * `tests/unit/tools` inteiro, `observability-hot-path-trace`,
 * `context-load-span-hot-path`, `agent-core-flow`, `agent-aggregate`,
 * `agent-core-trace-envelope-fail-closed` e `p10b-runtime-trace` incluídos.
 * O span `tool.dispatch` e a métrica `maia_tool_dispatch_total` sumiriam em
 * silêncio, e com eles os dois SLIs de tool (`maia:tool_error_ratio:rate5m` e
 * `maia:tool_blocked_ratio:rate5m`) — que passariam a não ter numerador nenhum.
 *
 * É a falha com que a #535 abre — "quem ler a taxonomia pode concluir que a
 * cobertura é maior do que é" — uma camada abaixo: quem ler
 * `instrumentation.spec.ts` conclui que o dispatch está instrumentado.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que estes casos entram por `dispatchTool`
 * ─────────────────────────────────────────────────────────────────────────
 * Chamar `instrumentToolDispatch()` aqui seria o mesmo espelho que deixou a
 * lacuna passar. `dispatchTool` é a fronteira que o react-loop chama, e é por
 * ela que estes casos entram — com as dependências colaterais dubladas (mesmo
 * conjunto de `dispatcher-tool-not-granted.spec.ts`), mas com o dispatcher, o
 * wrapper, o tracer e o registry de métricas REAIS.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Invariantes ABSOLUTAS, nunca delta
 * ─────────────────────────────────────────────────────────────────────────
 * `vitest.config.ts:130` tem `retry: 1` e a segunda tentativa herda a mutação
 * da primeira. "O contador subiu" ficaria verde na retry sem que nada
 * estivesse fiado. Cada caso zera o registry de métricas e o sink de spans e
 * afirma valor absoluto: a série vale EXATAMENTE 1 e existe EXATAMENTE um span
 * `tool.dispatch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * O tracer só emite com destino configurado (`tracingEnabled()`), e a suíte
 * unitária roda com o exporter inerte — que é o estado suportado. Um teste do
 * span precisa do estado ligado, então o contrato é lido por um Proxy que
 * sobrepõe as duas chaves que importam e delega o resto ao `config` real
 * (mesmo padrão de `tests/unit/observability/otlp-exporter.spec.ts`).
 *
 * O endpoint aqui nunca é contatado: o sink é dublado, então nada chega ao
 * exporter. Ratio 1 porque a amostragem é DERIVADA do trace id — com o default
 * de 0.05 o span do caso sumiria em ~95% das rodadas, o que é flake, não teste.
 */
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  const OVERRIDES: Readonly<Record<string, unknown>> = {
    MAIA_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces',
    MAIA_OTLP_SAMPLE_RATIO: 1,
  };
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) =>
        typeof prop === 'string' && prop in OVERRIDES
          ? OVERRIDES[prop]
          : Reflect.get(target, prop, receiver),
    }),
  };
});

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: {
      granted_packs: [] as string[],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    },
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async () => ({
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined,
      reservation_token: 'token-1',
    })),
    waitForCompletion: vi.fn(),
    markCompleted: vi.fn(async () => true),
    releaseReservation: vi.fn(async () => true),
    lookup: vi.fn(async () => null),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
  idempotencyOutboxRepo: { markCompletedWithEffect: vi.fn(async () => true) },
  agentToolGrantsRepo: { findForCurrentAgent: vi.fn(async () => grantState.grant) },
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/redis.js', () => ({ isRedisConnected: vi.fn(() => true) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/governance/idempotency.js', () => ({
  computeIdempotencyKey: vi.fn(() => 'computed-key-1'),
  computePayloadHash: vi.fn(() => 'payload-hash-1'),
}));
vi.mock('@/governance/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('@/governance/permissions.js')>(
    '@/governance/permissions.js',
  );
  return { ...actual, canAct: vi.fn(() => ({ allowed: true })) };
});
vi.mock('@/governance/rules.js', () => ({ constitutionalCheck: vi.fn(() => null) }));

const { handlerSpy } = vi.hoisted(() => ({ handlerSpy: vi.fn(async () => ({ ok: true })) }));

function fakeTool(name: string) {
  return {
    name,
    operation_type: 'read',
    required_actions: [],
    audit_action: 'balance_queried',
    input_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    output_schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    feature_flag: undefined,
    redis_required: false,
    handler: handlerSpy,
  };
}

vi.mock('@/tools/_registry.js', () => ({
  REGISTRY: { query_balance: fakeTool('query_balance') },
  isToolEnabled: () => true,
}));

import { dispatchTool } from '@/tools/_dispatcher.js';
import type { Conversa, Pessoa } from '@/db/schema.js';
import { _resetForTests as resetMetrics, renderPrometheus } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { METRIC, SPAN } from '@/observability/taxonomy.js';
import { _resetTracerForTests, setSpanSink, type EndedSpan } from '@/observability/tracer.js';

const fakeCtx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

/** Spans capturados no sink REAL do tracer — o mesmo que o exporter ocupa. */
const spans: EndedSpan[] = [];

/**
 * `counter()`/`histogram()` de `observability/metrics.ts` carimbam
 * `tenant_id`/`agent_id` a partir do ALS, e fora de um escopo resolvido o
 * bucket sancionado é `system`. `lib/metrics.ts` renderiza os rótulos em ordem
 * alfabética, então a linha é previsível byte a byte.
 */
function serie(metric: string, tool: string, result: string): string {
  return `${metric}{agent_id="system",result="${result}",tenant_id="system",tool="${tool}"}`;
}

/** O valor absoluto de uma série, ou `null` quando ela não existe. */
function valorDaSerie(corpo: string, linha: string): number | null {
  for (const l of corpo.split('\n')) {
    if (l.startsWith(`${linha} `)) return Number(l.slice(linha.length + 1));
  }
  return null;
}

function spansDeDispatch(): EndedSpan[] {
  return spans.filter((s) => s.name === SPAN.TOOL_DISPATCH);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMetrics();
  _resetLabelGuardForTests();
  spans.length = 0;
  setSpanSink((s) => void spans.push(s));
  grantState.grant = { granted_packs: [], granted_tools: [], denied_tools: [] };
});

afterEach(() => {
  _resetTracerForTests();
});

describe('issue #535 — dispatchTool ainda passa por instrumentToolDispatch', () => {
  /**
   * Troque `instrumentToolDispatch(input.tool, () => dispatchToolInner(input))`
   * por `dispatchToolInner(input)` em `src/tools/_dispatcher.ts:131` e este caso
   * reprova três vezes: sem contador, sem histograma e sem span.
   */
  it('um dispatch bem-sucedido publica contador, histograma e o span tool.dispatch', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };

    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toEqual({ ok: true });

    const corpo = await renderPrometheus();
    expect(valorDaSerie(corpo, serie(METRIC.TOOL_DISPATCH, 'query_balance', 'ok'))).toBe(1);
    expect(
      valorDaSerie(corpo, serie(`${METRIC.TOOL_DURATION_MS}_count`, 'query_balance', 'ok')),
    ).toBe(1);

    expect(spansDeDispatch()).toHaveLength(1);
    expect(spansDeDispatch()[0]!.attributes).toMatchObject({
      tool: 'query_balance',
      result: 'ok',
    });
  });

  /**
   * A outra metade do contrato: a recusa de governança chega ao rótulo como
   * `blocked`, e não como `error`. É o que mantém `maia:tool_error_ratio:rate5m`
   * legível durante uma fila de aprovações — e só vale se a classificação
   * estiver ligada NO dispatcher, não só no wrapper.
   */
  it('uma recusa de governança sai rotulada blocked, pela fronteira real', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core'],
      granted_tools: [],
      denied_tools: ['query_balance'],
    };

    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toEqual({ error: 'tool_not_granted', details: { tool: 'query_balance' } });

    const corpo = await renderPrometheus();
    expect(valorDaSerie(corpo, serie(METRIC.TOOL_DISPATCH, 'query_balance', 'blocked'))).toBe(1);
    expect(valorDaSerie(corpo, serie(METRIC.TOOL_DISPATCH, 'query_balance', 'error'))).toBeNull();

    expect(spansDeDispatch()).toHaveLength(1);
    expect(spansDeDispatch()[0]!.attributes).toMatchObject({
      tool: 'query_balance',
      result: 'blocked',
    });
  });

  /**
   * O nome do tool que a MODELO inventou também é um dispatch, e ele conta:
   * `unknown_tool` é a classe `invalid`, que mede qualidade de modelo/prompt e
   * não pode ser confundida com a plataforma quebrando.
   */
  it('um tool inexistente conta como invalid, não como error', async () => {
    await expect(
      dispatchTool({ tool: 'query_balance_typo', args: {}, ctx: fakeCtx }),
    ).resolves.toEqual({ error: 'unknown_tool', details: { tool: 'query_balance_typo' } });

    const corpo = await renderPrometheus();
    expect(
      valorDaSerie(corpo, serie(METRIC.TOOL_DISPATCH, 'query_balance_typo', 'invalid')),
    ).toBe(1);

    expect(spansDeDispatch()).toHaveLength(1);
    expect(spansDeDispatch()[0]!.attributes).toMatchObject({
      tool: 'query_balance_typo',
      result: 'invalid',
    });
  });
});
