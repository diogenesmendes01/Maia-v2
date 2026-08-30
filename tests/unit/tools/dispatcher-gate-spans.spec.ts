/**
 * Issue #535 — a FIAÇÃO dos quatro portões do dispatcher, não os wrappers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A lacuna que este arquivo fecha
 * ─────────────────────────────────────────────────────────────────────────
 * `constitutional.check`, `permission.check`, `idempotency.claim` e
 * `handler.execute` estavam na taxonomia desde a #514 sem uma linha de código
 * atrás deles. A decisão do dono na #535 foi que isso é dívida: ou o span ganha
 * emissor no caminho de produção, ou sai com justificativa. Os quatro ganharam,
 * e este arquivo é a prova de que ganharam NO CAMINHO — não num wrapper que
 * existe e ninguém chama.
 *
 * A distinção não é teórica neste repositório. O gate 6 da própria #535 já
 * tinha um spec verde para `context.load` enquanto o wrapper estava sobre uma
 * função cujo hot path a PR #406 havia removido: um teste que CHAMA a função
 * instrumentada não distingue "instrumentado" de "alcançado".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que estes casos entram por `dispatchTool`
 * ─────────────────────────────────────────────────────────────────────────
 * `dispatchTool` é a fronteira que o react-loop chama. Chamar
 * `instrumentPermissionCheck()` (ou qualquer um dos outros três) aqui seria o
 * mesmo espelho que deixou a lacuna passar. As dependências colaterais são
 * dubladas — o mesmo conjunto de `dispatcher-instrumentation-wiring.spec.ts` —
 * mas o dispatcher, os wrappers e o tracer são REAIS, e a sequência dos portões
 * é a sequência de produção.
 *
 * A sonda: apague `instrumentIdempotencyClaim(...)` de
 * `src/tools/_dispatcher.ts` (deixando o `tryReserve` nu) e este arquivo fica
 * vermelho no caso do `idempotency.claim`, com o nome do span na mensagem.
 * Idem para os outros três. Nenhum harness daqui reconstrói nenhuma das quatro
 * chamadas.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Invariantes ABSOLUTAS, nunca delta
 * ─────────────────────────────────────────────────────────────────────────
 * `vitest.config.ts` tem `retry: 1` e a segunda tentativa herda o estado de
 * módulo da primeira. "Saiu mais um span" ficaria verde na retry sem que nada
 * estivesse fiado. Cada caso zera o sink e afirma CONTAGEM EXATA.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * O tracer só emite com destino configurado (`tracingEnabled()`), e a suíte
 * unitária roda com o exporter inerte — que é o estado suportado e o default de
 * produção. Um teste de span precisa do estado ligado, então o contrato é lido
 * por um Proxy que sobrepõe as duas chaves que importam. O endpoint nunca é
 * contatado: o sink é dublado. Ratio 1 porque a amostragem é DERIVADA do trace
 * id — com o default de 0.05 o span do caso sumiria em ~95% das rodadas.
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

const { estado } = vi.hoisted(() => ({
  estado: {
    grant: {
      granted_packs: ['baseline.core', 'domain.finance'] as string[],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    },
    /** O que `canAct` responde. Trocado por caso. */
    permitir: true,
    /** O que `constitutionalCheck` responde. Trocado por caso. */
    violacao: null as { kind: string; rule_id?: string; reason: string } | null,
    /** O que `tryReserve` responde. Trocado por caso. */
    reserva: {
      was_inserted: true,
      state: 'in_progress',
      resultado: undefined as unknown,
      reservation_token: 'token-1' as string | undefined,
    },
    /** O handler explode? */
    handlerLanca: false,
  },
}));

vi.mock('@/db/repositories.js', () => ({
  idempotencyRepo: {
    tryReserve: vi.fn(async () => estado.reserva),
    waitForCompletion: vi.fn(),
    markCompleted: vi.fn(async () => true),
    releaseReservation: vi.fn(async () => true),
    abandonReservation: vi.fn(async () => true),
    lookup: vi.fn(async () => null),
    store: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => 0),
  },
  idempotencyOutboxRepo: { markCompletedWithEffect: vi.fn(async () => true) },
  agentToolGrantsRepo: { findForCurrentAgent: vi.fn(async () => estado.grant) },
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
  return {
    ...actual,
    canAct: vi.fn(() =>
      estado.permitir ? { allowed: true } : { allowed: false, reason: 'profile lacks action' },
    ),
  };
});
vi.mock('@/governance/rules.js', () => ({
  constitutionalCheck: vi.fn(() => estado.violacao),
}));

const { handlerSpy } = vi.hoisted(() => ({
  handlerSpy: vi.fn(async () => ({ ok: true })),
}));

function fakeTool(name: string) {
  return {
    name,
    operation_type: 'read',
    // NÃO vazio: `permission.check` mede o laço de `canAct`, e um laço de zero
    // iterações não prova que o portão está fiado.
    required_actions: ['view_balance'],
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
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { SPAN, SPAN_PARENT } from '@/observability/taxonomy.js';
import {
  _resetTracerForTests,
  isDeclaredAncestor,
  setSpanSink,
  type EndedSpan,
} from '@/observability/tracer.js';
import { _resetForTests as resetMetrics } from '@/lib/metrics.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

const fakeCtx = {
  pessoa: { id: 'p1' } as unknown as Pessoa,
  scope: { entidades: ['e-1'], byEntity: new Map() },
  conversa: { id: 'c1' } as unknown as Conversa,
  mensagem_id: 'm1',
  request_id: 'r1',
};

const spans: EndedSpan[] = [];
const de = (name: string): EndedSpan[] => spans.filter((s) => s.name === name);

beforeEach(() => {
  vi.clearAllMocks();
  resetMetrics();
  _resetLabelGuardForTests();
  spans.length = 0;
  setSpanSink((s) => void spans.push(s));
  estado.grant = {
    granted_packs: ['baseline.core', 'domain.finance'],
    granted_tools: [],
    denied_tools: [],
  };
  estado.permitir = true;
  estado.violacao = null;
  estado.reserva = {
    was_inserted: true,
    state: 'in_progress',
    resultado: undefined,
    reservation_token: 'token-1',
  };
  estado.handlerLanca = false;
  handlerSpy.mockImplementation(async () => {
    if (estado.handlerLanca) throw new Error('handler explodiu');
    return { ok: true };
  });
});

afterEach(() => {
  _resetTracerForTests();
});

describe('issue #535 — os quatro portões do dispatcher abrem span de verdade', () => {
  it('um dispatch completo abre os quatro, um de cada, sob tool.dispatch', async () => {
    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toEqual({ ok: true });

    const dispatch = de(SPAN.TOOL_DISPATCH);
    expect(dispatch).toHaveLength(1);

    // Uma asserção por span, nomeada: apagar `instrumentHandlerExecute` de
    // `src/tools/_dispatcher.ts` tem que dizer "handler.execute".
    for (const name of [
      SPAN.CONSTITUTIONAL_CHECK,
      SPAN.PERMISSION_CHECK,
      SPAN.IDEMPOTENCY_CLAIM,
      SPAN.HANDLER_EXECUTE,
    ]) {
      expect(
        de(name).length,
        `o dispatch não abriu \`${name}\` — o emissor sumiu do call site de produção?`,
      ).toBe(1);
      // E cada um pendura no dispatch, que é o pai que `SPAN_PARENT` declara.
      // Um portão solto seria pior que ausente: apareceria na waterfall sem
      // dizer a QUAL dispatch pertence.
      expect(SPAN_PARENT[name]).toBe(SPAN.TOOL_DISPATCH);
      expect(de(name)[0]!.parent_span_id, `${name} não é filho do dispatch`).toBe(
        dispatch[0]!.span_id,
      );
      expect(isDeclaredAncestor(name, SPAN.TURN)).toBe(true);
      // Todos carregam o nome do tool — sem ele a waterfall de um turno com
      // cinco tools não diz qual portão pertence a qual chamada.
      expect(de(name)[0]!.attributes.tool).toBe('query_balance');
    }
  });

  it('a ordem exportada é a ordem em que o dispatcher roda os portões', async () => {
    await dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx });

    // A waterfall só é lida corretamente se a sequência for a real. Esta
    // asserção pega o erro de instrumentar o portão certo no lugar errado —
    // por exemplo medir a reserva ANTES da aprovação, que inverteria a leitura
    // de "o que estava esperando".
    const inicios = [
      SPAN.CONSTITUTIONAL_CHECK,
      SPAN.PERMISSION_CHECK,
      SPAN.IDEMPOTENCY_CLAIM,
      SPAN.HANDLER_EXECUTE,
    ].map((n) => de(n)[0]!.start_unix_nano);
    for (let i = 1; i < inicios.length; i++) {
      expect(inicios[i]! >= inicios[i - 1]!).toBe(true);
    }
  });

  it('a recusa constitucional sai como `forbidden`, e os portões seguintes NÃO abrem', async () => {
    estado.violacao = { kind: 'forbidden', rule_id: 'C-001', reason: 'acima do limite duro' };

    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toMatchObject({ error: 'forbidden' });

    expect(de(SPAN.CONSTITUTIONAL_CHECK)).toHaveLength(1);
    expect(de(SPAN.CONSTITUTIONAL_CHECK)[0]!.attributes.result).toBe('forbidden');
    // O `rule_id` é identificador autorado pelo tenant, sem teto: fica no audit
    // row, não no span que sai para um collector de terceiro.
    expect(Object.values(de(SPAN.CONSTITUTIONAL_CHECK)[0]!.attributes)).not.toContain('C-001');
    // Um span de portão que nunca rodou seria pior que nenhum: leria como
    // "checamos e passou".
    expect(de(SPAN.PERMISSION_CHECK)).toHaveLength(0);
    expect(de(SPAN.IDEMPOTENCY_CLAIM)).toHaveLength(0);
    expect(de(SPAN.HANDLER_EXECUTE)).toHaveLength(0);
  });

  it('a exigência de aprovação NÃO é `forbidden` — é `requires_approval`', async () => {
    // A distinção que o vocabulário existe para preservar: um fluxo de dupla
    // aprovação FUNCIONANDO não pode aparecer como negação de governança.
    estado.violacao = { kind: 'limit_exceeded', reason: 'exige quatro olhos' };

    // Escopo de tenant REAL aqui, e só aqui: este é o único caso que chega ao
    // fluxo de aprovação, que lê `getCurrentTenant()` para compor o
    // `intent_hash`. Os demais casos param antes e não precisam — dar escopo a
    // todos esconderia que a maior parte do dispatcher não depende dele.
    await runWithTenantContext({ tenant_id: 't-535', agent_id: 'a-535' }, () =>
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).catch(() => undefined);

    expect(de(SPAN.CONSTITUTIONAL_CHECK)[0]!.attributes.result).toBe('requires_approval');
  });

  it('a negação de permissão sai como `denied` e para o dispatch ali', async () => {
    estado.permitir = false;

    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toMatchObject({ error: 'forbidden' });

    expect(de(SPAN.PERMISSION_CHECK)).toHaveLength(1);
    expect(de(SPAN.PERMISSION_CHECK)[0]!.attributes.result).toBe('denied');
    // UM span para o laço inteiro, com a contagem de ações no atributo — não um
    // span por ação, que renderizaria N-1 linhas idênticas para uma decisão só.
    expect(de(SPAN.PERMISSION_CHECK)[0]!.attributes.item_count).toBe(1);
    // A razão da negação é texto livre de `canAct`: proibido como atributo.
    expect(Object.values(de(SPAN.PERMISSION_CHECK)[0]!.attributes)).not.toContain(
      'profile lacks action',
    );
    expect(de(SPAN.IDEMPOTENCY_CLAIM)).toHaveLength(0);
    expect(de(SPAN.HANDLER_EXECUTE)).toHaveLength(0);
  });

  it('a reserva vencida marca `reserved`; a perdida marca o estado que a devolveu', async () => {
    await dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx });
    // `was_inserted` é o que separa o VENCEDOR do que espera — os dois voltam
    // `state: 'in_progress'` do repositório, e colapsá-los tornaria o atributo
    // inútil justamente na investigação que ele existe para servir.
    expect(de(SPAN.IDEMPOTENCY_CLAIM)[0]!.attributes.state).toBe('reserved');

    spans.length = 0;
    estado.reserva = {
      was_inserted: false,
      state: 'completed',
      resultado: { ok: 'cacheado' },
      reservation_token: undefined,
    };
    await dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx });
    expect(de(SPAN.IDEMPOTENCY_CLAIM)[0]!.attributes.state).toBe('completed');
    // Cache hit: o handler não roda, e o span dele não pode existir.
    expect(de(SPAN.HANDLER_EXECUTE)).toHaveLength(0);
  });

  it('um handler que explode fecha o span com status error, sem mudar o fluxo', async () => {
    estado.handlerLanca = true;

    // O contrato do dispatcher é devolver `{ error }`, nunca lançar — o
    // react-loop trata throw como plataforma quebrada. O span registra a falha
    // sem participar disso.
    await expect(
      dispatchTool({ tool: 'query_balance', args: {}, ctx: fakeCtx }),
    ).resolves.toMatchObject({ error: 'execution_failed' });

    expect(de(SPAN.HANDLER_EXECUTE)).toHaveLength(1);
    expect(de(SPAN.HANDLER_EXECUTE)[0]!.status).toBe('error');
    // A mensagem do erro é string crua: proibida como atributo de span.
    expect(Object.values(de(SPAN.HANDLER_EXECUTE)[0]!.attributes)).not.toContain(
      'handler explodiu',
    );
  });
});
