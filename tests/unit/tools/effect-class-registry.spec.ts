/**
 * Issue #507 §Tools — a classificação de efeito é OBRIGATÓRIA, e o registro
 * recusa subir sem ela.
 *
 * ─── O que este arquivo prova, e por que cada bloco existe ──────────────────
 *
 * 1. O VOCABULÁRIO é o da decisão do dono, escrito à mão aqui. Derivá-lo de
 *    `TOOL_EFFECT_CLASSES` faria a asserção concordar com qualquer regressão —
 *    inclusive com alguém acrescentando uma quinta classe permissiva.
 *
 * 2. TODA ferramenta do registro declara uma delas. Não por amostragem: o
 *    conjunto varrido é `REGISTRY` ∪ tools gated por config (que somem do
 *    REGISTRY quando o flag está off e, sem isso, escapariam da varredura).
 *
 * 3. O REGISTRO RECUSA. E o teste não chama só o validador: ele MOCKA um módulo
 *    de tool para devolver uma definição sem `effect_class` e então IMPORTA
 *    `_registry.ts`. O import LANÇA — que é o comportamento real de boot, não
 *    uma simulação dele. É a sonda vermelha da issue, automatizada.
 *
 * 4. A MATRIZ de cancelamento é exaustiva sobre as quatro classes, e a
 *    invariante "`effect_unknown` nunca nasce `retryable`" é verificada em
 *    TODAS elas — não numa amostra.
 *
 * O tipo `ToolCancellationVerdict` já impede `{ outcome: 'effect_unknown',
 * retryable: true }` no compilador; este arquivo cobre o outro lado, o de
 * alguém trocando a implementação da matriz.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOOL_EFFECT_CLASSES,
  RECONCILIATION_STRATEGIES,
  classifyToolCancellation,
  minimumBudgetMs,
  assertToolDefinitionsComplete,
  ToolDefinitionError,
  MCP_TOOL_EFFECT_CLASS,
  TOOL_MIN_BUDGET_MS,
  type ToolEffectClass,
  type ClassifiableToolDefinition,
} from '@/tools/effect-class.js';

/** As quatro classes da decisão do dono, escritas à mão de propósito. */
const CLASSES_DA_DECISAO = ['abort_safe', 'idempotent', 'non_interruptible', 'compensatable'];

describe('#507 — o vocabulário de classes de efeito é o da decisão, e é fechado', () => {
  it('tem exatamente as quatro classes, sem sinônimos nem adições silenciosas', () => {
    expect([...TOOL_EFFECT_CLASSES].sort()).toEqual([...CLASSES_DA_DECISAO].sort());
  });

  it('as estratégias de reconciliação são um conjunto fechado e pequeno', () => {
    expect([...RECONCILIATION_STRATEGIES].sort()).toEqual(
      ['compensate', 'manual_reconciliation', 'replay_idempotency_key'].sort(),
    );
  });
});

describe('#507 — a matriz de cancelamento é determinística e nunca convida a um retry cego', () => {
  it('`abort_safe` é a ÚNICA classe que pode dizer "cancelado"', () => {
    const dizemCancelado = TOOL_EFFECT_CLASSES.filter(
      (c) => classifyToolCancellation(c).outcome === 'cancelled',
    );
    expect(dizemCancelado).toEqual(['abort_safe']);
  });

  it.each(TOOL_EFFECT_CLASSES)(
    '%s: quando o veredito é `effect_unknown`, `retryable` é false e há estratégia de reconciliação',
    (cls) => {
      const verdict = classifyToolCancellation(cls);
      if (verdict.outcome === 'effect_unknown') {
        expect(verdict.retryable).toBe(false);
        expect(RECONCILIATION_STRATEGIES).toContain(verdict.reconciliation);
      } else {
        // O outro ramo só existe para quem DECLAROU não deixar efeito.
        expect(cls).toBe('abort_safe');
        expect(verdict.retryable).toBe(true);
      }
    },
  );

  it('a reconciliação de cada classe é a que a issue descreve', () => {
    expect(classifyToolCancellation('idempotent')).toEqual({
      outcome: 'effect_unknown',
      retryable: false,
      reconciliation: 'replay_idempotency_key',
    });
    expect(classifyToolCancellation('compensatable')).toEqual({
      outcome: 'effect_unknown',
      retryable: false,
      reconciliation: 'compensate',
    });
    expect(classifyToolCancellation('non_interruptible')).toEqual({
      outcome: 'effect_unknown',
      retryable: false,
      reconciliation: 'manual_reconciliation',
    });
  });

  it('valor FORA do vocabulário cai no veredito mais conservador, nunca em "cancelado"', () => {
    // Defesa em profundidade: o registro já recusaria, mas uma superfície
    // dinâmica (mock, catálogo vindo do banco) pode entregar lixo. Errar para
    // `cancelled` afirmaria ausência de efeito sobre uma tool desconhecida.
    const verdict = classifyToolCancellation('gambiarra' as unknown as ToolEffectClass);
    expect(verdict).toEqual({
      outcome: 'effect_unknown',
      retryable: false,
      reconciliation: 'manual_reconciliation',
    });
  });
});

describe('#507 — o orçamento mínimo separa quem pode deixar efeito de quem não pode', () => {
  it('só `abort_safe` começa com o piso; as demais exigem reserva para PERSISTIR o efeito', () => {
    expect(minimumBudgetMs('abort_safe')).toBe(TOOL_MIN_BUDGET_MS);
    for (const cls of TOOL_EFFECT_CLASSES.filter((c) => c !== 'abort_safe')) {
      expect(minimumBudgetMs(cls)).toBeGreaterThan(minimumBudgetMs('abort_safe'));
    }
  });
});

describe('#507 — o validador RECUSA definição incompleta ou incoerente', () => {
  const base: ClassifiableToolDefinition = {
    name: 'ferramenta_ok',
    side_effect: 'read',
    effect_class: 'abort_safe',
  };
  const nomes = new Set(['ferramenta_ok', 'compensador_existente']);

  it('aceita um conjunto completo e coerente', () => {
    expect(() => assertToolDefinitionsComplete([base], nomes)).not.toThrow();
  });

  it('SEM `effect_class` → lança, e a mensagem nomeia a ferramenta', () => {
    const semClasse = { name: 'ferramenta_nova', side_effect: 'write' } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([base, semClasse], nomes)).toThrow(
      ToolDefinitionError,
    );
    try {
      assertToolDefinitionsComplete([base, semClasse], nomes);
      expect.unreachable('o validador deveria ter lançado');
    } catch (err) {
      const e = err as ToolDefinitionError;
      expect(e.code).toBe('TOOL_DEFINITION_INCOMPLETE');
      expect(e.problems).toHaveLength(1);
      expect(e.problems[0]).toContain('ferramenta_nova');
      expect(e.message).toContain('effect_class');
    }
  });

  it('classe fora do vocabulário → lança', () => {
    const invalida = {
      name: 'ferramenta_esquisita',
      side_effect: 'read',
      effect_class: 'best_effort',
    } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([invalida], nomes)).toThrow(/inválida/);
  });

  it('`side_effect: write` + `abort_safe` → contradição interna, lança', () => {
    const contraditoria = {
      name: 'escreve_mas_diz_que_nao',
      side_effect: 'write',
      effect_class: 'abort_safe',
    } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([contraditoria], nomes)).toThrow(
      /não pode ser cancelada sem efeito/,
    );
  });

  it('`compensatable` SEM compensador declarado → lança (promessa vazia)', () => {
    const semCompensador = {
      name: 'promete_compensacao',
      side_effect: 'write',
      effect_class: 'compensatable',
    } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([semCompensador], nomes)).toThrow(
      /sem compensador declarado/,
    );
  });

  it('`compensated_by` apontando para tool inexistente → lança', () => {
    const compensadorFantasma = {
      name: 'aponta_para_o_nada',
      side_effect: 'write',
      effect_class: 'compensatable',
      compensated_by: 'tool_que_nao_existe',
    } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([compensadorFantasma], nomes)).toThrow(
      /não é uma ferramenta do registro/,
    );
  });

  it('`compensated_by` em quem NÃO é `compensatable` → lança (campo que ninguém lê envelhece mentindo)', () => {
    const sobrando = {
      name: 'campo_orfao',
      side_effect: 'write',
      effect_class: 'idempotent',
      compensated_by: 'compensador_existente',
    } as ClassifiableToolDefinition;
    expect(() => assertToolDefinitionsComplete([sobrando], nomes)).toThrow(/sem ser `compensatable`/);
  });

  it('acumula TODOS os problemas numa recusa só — não para no primeiro', () => {
    const a = { name: 'a', side_effect: 'write' } as ClassifiableToolDefinition;
    const b = { name: 'b', side_effect: 'write', effect_class: 'abort_safe' } as ClassifiableToolDefinition;
    try {
      assertToolDefinitionsComplete([a, b], nomes);
      expect.unreachable('o validador deveria ter lançado');
    } catch (err) {
      expect((err as ToolDefinitionError).problems).toHaveLength(2);
    }
  });
});

describe('#507 — as ferramentas MCP são dinâmicas, mas classificadas mesmo assim', () => {
  it('a constante do bridge é `abort_safe` PORQUE a fase v1 só despacha read-only', () => {
    // Guarda de condição: quando a fase de ESCRITA do MCP chegar, esta
    // constante deixa de valer para todas as tools e a classe precisa virar um
    // campo por tool no catálogo (`mcp_server_tools`). Este teste é o lembrete
    // que falha junto com a premissa.
    expect(MCP_TOOL_EFFECT_CLASS).toBe('abort_safe');
  });
});

/**
 * A SONDA VERMELHA da issue, automatizada: uma ferramenta sem classificação
 * chega ao registro e o MÓDULO NÃO CARREGA.
 *
 * Não é o validador chamado à mão — é o `import('@/tools/_registry.js')` real
 * rejeitando, que é o mesmo caminho do boot de produção. Um dos módulos de tool
 * é mockado para devolver uma definição sem `effect_class`; o registro monta o
 * `REGISTRY` com ela e a checagem de topo de módulo lança.
 */
describe('#507 — SONDA: o REGISTRO recusa carregar com uma ferramenta sem classificação', () => {
  beforeEach(() => {
    vi.resetModules();
    // O registro puxa o grafo de produção; estes stubs mantêm o import leve
    // (sem timer de presença, sem socket Redis) — mesmo padrão de
    // tests/unit/tool-catalog-drift.spec.ts.
    vi.doMock('@/lib/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('@/gateway/baileys.js', () => ({
      MEDIA_ROOT: '/tmp/maia-effect-class-probe',
      ensureMediaDirs: vi.fn(),
    }));
    vi.doMock('@/gateway/presence.js', () => ({ markRead: vi.fn() }));
    vi.doMock('@/gateway/queue.js', () => ({ enqueueAgent: vi.fn(), agentQueue: {} }));
  });

  afterEach(() => {
    vi.doUnmock('@/tools/audit-decision.js');
    vi.resetModules();
  });

  it('CONTROLE: sem adulteração, o registro carrega e toda tool tem classe válida', async () => {
    const { REGISTRY, buildToolCatalog } = await import('@/tools/_registry.js');
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(50);
    // O catálogo cobre também as tools gated por config (ausentes do REGISTRY
    // quando o flag está off) — o mesmo universo que o portão valida.
    for (const { tool } of buildToolCatalog()) {
      expect(
        TOOL_EFFECT_CLASSES,
        `${tool.name} não declara uma classe de efeito válida`,
      ).toContain(tool.effect_class);
    }
  });

  it('nenhuma tool `side_effect: write` se declara `abort_safe`', async () => {
    const { buildToolCatalog } = await import('@/tools/_registry.js');
    const mentirosas = buildToolCatalog()
      .filter(({ tool }) => tool.side_effect === 'write' && tool.effect_class === 'abort_safe')
      .map(({ tool }) => tool.name);
    expect(mentirosas).toEqual([]);
  });

  it('toda `compensatable` aponta para um compensador que EXISTE no registro', async () => {
    const { buildToolCatalog } = await import('@/tools/_registry.js');
    const catalogo = buildToolCatalog();
    const nomes = new Set(catalogo.map(({ tool }) => tool.name));
    const compensaveis = catalogo.filter(({ tool }) => tool.effect_class === 'compensatable');
    // Guarda contra verde vácuo: se ninguém for `compensatable`, a asserção
    // abaixo passaria sem provar nada.
    expect(compensaveis.length).toBeGreaterThan(0);
    for (const { tool } of compensaveis) {
      expect(typeof tool.compensated_by).toBe('string');
      expect(nomes, `${tool.name} → ${tool.compensated_by}`).toContain(tool.compensated_by);
    }
  });

  it('SONDA VERMELHA: uma tool sem `effect_class` faz o import do registro LANÇAR', async () => {
    const { auditDecisionTool } = await import('@/tools/audit-decision.js');
    const semClassificacao = { ...auditDecisionTool } as Record<string, unknown>;
    delete semClassificacao.effect_class;
    semClassificacao.name = 'ferramenta_nova_sem_classificacao';
    vi.resetModules();
    vi.doMock('@/tools/audit-decision.js', () => ({ auditDecisionTool: semClassificacao }));

    await expect(import('@/tools/_registry.js')).rejects.toThrow(
      /ferramenta_nova_sem_classificacao: não declara `effect_class`/,
    );
  });
});
