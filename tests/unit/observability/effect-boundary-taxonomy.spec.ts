/**
 * Issue #601 — `maia_turn_effect_blocked_total` passa a ser emitida pela camada
 * SANCIONADA, e a dimensão `boundary` passa a ser um contrato.
 *
 * O defeito: `reportBlockedEffect` (`src/runtime/turns/execution-context.ts`,
 * issue #504) chamava `src/lib/metrics.ts::incCounter` DIRETO — o transporte —,
 * contornando `src/observability/metrics.ts::counter`. Três consequências:
 *
 *   1. a série não recebia `tenant_id` + `agent_id`, então um pico dizia que o
 *      fencing atuou e não dizia PARA QUEM — a primeira pergunta de um
 *      incidente multi-tenant, e a invariante #1 do AGENTS.md;
 *   2. `boundary` nem estava em `ALLOWED_LABEL_KEYS`: o rótulo saía cru, sem
 *      guarda de PII, de forma nem de cardinalidade;
 *   3. "cardinalidade fechada" era um comentário, não uma regra.
 *
 * É o MESMO defeito que a PR #599 corrigiu em
 * `maia_cognitive_module_cancelled_total`, e este arquivo espelha os casos
 * daquela correção (`tests/unit/cognition-runner.spec.ts`): atribuição, forma e
 * overflow de cardinalidade.
 *
 * O que a correção NÃO podia fazer: apagar `boundary`. A barreira de
 * `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts` lê esse
 * rótulo para afirmar QUAL limite recusou o efeito — sem ele o teste volta a
 * medir "alguém barrou", que é o falso verde que a revisão da #599 pegou. Por
 * isso o último bloco aqui prova o contrário: os quinze nomes continuam
 * chegando à série, um a um, distinguíveis.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  CARDINALITY_OVERFLOW_VALUE,
  CLOSED_VOCABULARY_FALLBACK,
  DEFAULT_LABEL_CARDINALITY_BUDGET,
  EFFECT_BOUNDARY,
  EFFECT_BOUNDARY_METRIC_VALUES,
  EFFECT_BOUNDARY_VALUES,
  LABEL_CARDINALITY_BUDGET,
  METRIC,
  METRIC_NAMES,
  ALLOWED_LABEL_KEYS,
} from '../../../src/observability/taxonomy.js';
import type { EffectBoundary } from '../../../src/observability/taxonomy.js';
import { counter } from '../../../src/observability/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';
import { runWithTenantContext } from '../../../src/db/tenant-context.js';
import { reportBlockedEffect } from '../../../src/runtime/turns/execution-context.js';

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
});

/** As linhas da exposição que pertencem à série de efeito barrado. */
async function seriesBloqueadas(): Promise<string[]> {
  const exposicao = await renderPrometheus();
  return exposicao.split('\n').filter((l) => l.startsWith(METRIC.TURN_EFFECT_BLOCKED));
}

/** O mesmo extrator que a barreira da #599 usa, palavra por palavra. */
async function boundariesBloqueados(): Promise<string[]> {
  return (await seriesBloqueadas())
    .map((l) => /boundary="([^"]+)"/.exec(l)?.[1] ?? '?')
    .sort();
}

const ESCOPO = { tenant_id: 'tenant-601', agent_id: 'agent-601' };

// ---------------------------------------------------------------------------
// 1. O vocabulário é espelho do código, não uma lista paralela
// ---------------------------------------------------------------------------

describe('issue #601 — `boundary` é um vocabulário FECHADO espelhado do código', () => {
  /**
   * Todo literal de limite de efeito que o `src/` passa aos guards. Se alguém
   * abrir um limite novo sem declarar o nome na taxonomia, este caso falha —
   * que é o ponto: o budget de cardinalidade só limita algo real enquanto a
   * lista for a lista.
   */
  async function literaisNoCodigo(): Promise<string[]> {
    const arquivos = [
      'src/agent/core.ts',
      'src/agent/react-loop.ts',
      'src/agent/output-dispatch.ts',
      'src/cognition/role-selector/engine.ts',
      'src/runtime/decision/integration.ts',
      'src/tools/_dispatcher.ts',
      'src/tools/mcp-bridge.ts',
    ];
    const encontrados = new Set<string>();
    for (const rel of arquivos) {
      const src = await readFile(new URL(`../../../${rel}`, import.meta.url), 'utf8');
      const re =
        /(?:assertTurnOwnership|reportBlockedEffect|assertOutboundOwnership|new TurnOwnershipLostError)\(\s*'([a-z_]+)'/g;
      for (const m of src.matchAll(re)) encontrados.add(m[1]!);
      const reDispatcher = /turnOwnershipLostResult\([^,]+,\s*'([a-z_]+)'\)/g;
      for (const m of src.matchAll(reDispatcher)) encontrados.add(m[1]!);
    }
    return [...encontrados].sort();
  }

  it('a varredura do código encontra limites de verdade (senão tudo abaixo é verde vazio)', async () => {
    expect((await literaisNoCodigo()).length).toBeGreaterThanOrEqual(15);
  });

  it('`EFFECT_BOUNDARY` cobre EXATAMENTE os limites que o código usa', async () => {
    expect([...EFFECT_BOUNDARY_VALUES].sort()).toEqual(await literaisNoCodigo());
  });

  it('a lista da SÉRIE são os 15 que passam por `reportBlockedEffect`', () => {
    expect(EFFECT_BOUNDARY_METRIC_VALUES).toHaveLength(15);
    // `react_tool_refused` é só do erro: a recusa dele já foi contada um quadro
    // antes como `tool_dispatch`/`tool_handler`, e contá-la de novo somaria dois
    // pontos para UM efeito barrado.
    expect(EFFECT_BOUNDARY_METRIC_VALUES).not.toContain(EFFECT_BOUNDARY.REACT_TOOL_REFUSED);
    expect(EFFECT_BOUNDARY_VALUES).toContain(EFFECT_BOUNDARY.REACT_TOOL_REFUSED);
  });

  it('o runbook documenta a MESMA lista que a série pode emitir', async () => {
    const runbook = await readFile(
      new URL('../../../docs/runbooks/turn-state-machine.md', import.meta.url),
      'utf8',
    );
    const linha = runbook
      .split('\n')
      .find((l) => l.includes(METRIC.TURN_EFFECT_BLOCKED) && l.includes('boundary'));
    expect(linha, 'o runbook tem de documentar a série').toBeDefined();
    for (const b of EFFECT_BOUNDARY_METRIC_VALUES) {
      expect(linha, `runbook não lista o limite '${b}'`).toContain(`\`${b}\``);
    }
  });

  it('a série e a chave estão DECLARADAS na taxonomia, com budget próprio', () => {
    expect(METRIC_NAMES).toContain(METRIC.TURN_EFFECT_BLOCKED);
    expect(ALLOWED_LABEL_KEYS.has('boundary')).toBe(true);
    const budget = LABEL_CARDINALITY_BUDGET['boundary'];
    expect(budget, '`boundary` precisa de budget próprio, não do default').toBeDefined();
    expect(budget).not.toBe(DEFAULT_LABEL_CARDINALITY_BUDGET);
    // Teto do contrato: os 15 emissíveis + o `other` do colapso, com folga.
    expect(budget!).toBeGreaterThanOrEqual(EFFECT_BOUNDARY_METRIC_VALUES.length + 1);
  });

  it('`execution-context.ts` não emite mais por `@/lib/metrics` direto', async () => {
    const src = await readFile(
      new URL('../../../src/runtime/turns/execution-context.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/from '@\/lib\/metrics/);
    expect(src).toMatch(/from '@\/observability\/metrics/);
  });
});

// ---------------------------------------------------------------------------
// 2. Atribuição — o que a issue abriu para consertar
// ---------------------------------------------------------------------------

describe('issue #601 — a série é ATRIBUÍDA ao tenant que perdeu o turno', () => {
  it('ATRIBUIÇÃO: a série carrega tenant_id + agent_id do escopo', async () => {
    await runWithTenantContext(ESCOPO, async () => {
      reportBlockedEffect(EFFECT_BOUNDARY.OUTBOUND_SEND);
    });

    const [linha] = await seriesBloqueadas();
    expect(linha, 'a série de efeito barrado tem de ser emitida').toBeDefined();
    expect(linha).toContain('tenant_id="tenant-601"');
    expect(linha).toContain('agent_id="agent-601"');
    // E a dimensão que a barreira da #599 consome continua lá.
    expect(linha).toContain('boundary="outbound_send"');
  });

  it('fora de escopo de tenant a série cai no bucket sancionado `system`', async () => {
    reportBlockedEffect(EFFECT_BOUNDARY.PENDING_GATE);

    const [linha] = await seriesBloqueadas();
    expect(linha).toContain('tenant_id="system"');
    expect(linha).toContain('agent_id="system"');
    // AGENTS.md §4.8 recusa o literal 'default' como bucket compartilhado.
    expect(linha).not.toContain('"default"');
  });

  it('dois tenants perdendo turno produzem DUAS séries, não uma soma anônima', async () => {
    await runWithTenantContext({ tenant_id: 't-a', agent_id: 'a-a' }, async () => {
      reportBlockedEffect(EFFECT_BOUNDARY.DECISION_ENGINE);
    });
    await runWithTenantContext({ tenant_id: 't-b', agent_id: 'a-b' }, async () => {
      reportBlockedEffect(EFFECT_BOUNDARY.DECISION_ENGINE);
    });

    const linhas = await seriesBloqueadas();
    expect(linhas).toHaveLength(2);
    expect(linhas.some((l) => l.includes('tenant_id="t-a"'))).toBe(true);
    expect(linhas.some((l) => l.includes('tenant_id="t-b"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Forma e overflow — o padrão da #599
// ---------------------------------------------------------------------------

describe('issue #601 — o rótulo é fechado em runtime, não só no compilador', () => {
  it('FORMA: um valor fora do vocabulário vira `other` e o texto livre não sobrevive', async () => {
    // O call site hostil: um cast que fura o tipo `EffectBoundary`.
    await runWithTenantContext(ESCOPO, async () => {
      reportBlockedEffect(
        'outbound_send para Fechamento Mensal da Loja' as unknown as EffectBoundary,
      );
    });

    const [linha] = await seriesBloqueadas();
    expect(linha).toContain(`boundary="${CLOSED_VOCABULARY_FALLBACK}"`);
    expect(linha, 'texto livre não pode virar label').not.toContain('Fechamento');
  });

  it('mil valores fora do contrato produzem UMA série, não mil', async () => {
    await runWithTenantContext(ESCOPO, async () => {
      for (let i = 0; i < 1000; i++) {
        reportBlockedEffect(`limite-inventado-${i}` as unknown as EffectBoundary);
      }
    });

    const linhas = await seriesBloqueadas();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain(`boundary="${CLOSED_VOCABULARY_FALLBACK}"`);
  });

  it('OVERFLOW: o budget por (métrica, chave) fecha a cardinalidade mesmo sem o colapso', async () => {
    // O colapso do vocabulário roda ANTES do sanitizador, então este caso ataca
    // a segunda linha de defesa direto — a que sobra se alguém um dia emitir
    // esta série de um call site novo sem passar por `reportBlockedEffect`.
    const budget = LABEL_CARDINALITY_BUDGET['boundary'] ?? DEFAULT_LABEL_CARDINALITY_BUDGET;
    await runWithTenantContext(ESCOPO, async () => {
      for (let i = 0; i <= budget + 1; i++) {
        counter(METRIC.TURN_EFFECT_BLOCKED, { boundary: `boundary_${i}` });
      }
    });

    const linhas = await seriesBloqueadas();
    expect(
      linhas.some((l) => l.includes(`boundary="${CARDINALITY_OVERFLOW_VALUE}"`)),
      'passado o budget, o excedente tem de colapsar no bucket de overflow',
    ).toBe(true);
    expect(
      linhas.length,
      'e o número de séries não pode crescer com o número de valores',
    ).toBeLessThanOrEqual(budget + 1);
  });
});

// ---------------------------------------------------------------------------
// 4. A barreira da #599 continua podendo distinguir O LIMITE
// ---------------------------------------------------------------------------

describe('issue #601 — a barreira da #599 continua sensível', () => {
  it('cada um dos 15 limites chega à série com o próprio nome', async () => {
    for (const b of EFFECT_BOUNDARY_METRIC_VALUES) {
      _resetForTests();
      _resetLabelGuardForTests();
      await runWithTenantContext(ESCOPO, async () => {
        reportBlockedEffect(b);
      });
      expect(
        await boundariesBloqueados(),
        `a série tem de dizer que quem recusou foi '${b}'`,
      ).toEqual([b]);
    }
  });

  it('dois limites distintos NÃO colapsam num só ponto', async () => {
    await runWithTenantContext(ESCOPO, async () => {
      reportBlockedEffect(EFFECT_BOUNDARY.PENDING_GATE);
      reportBlockedEffect(EFFECT_BOUNDARY.SCHEDULING_INBOUND_HOOK);
    });
    // Se `boundary` tivesse sido apagada na migração, isto seria uma série só e
    // a barreira voltaria a medir "alguém barrou".
    expect(await boundariesBloqueados()).toEqual(['pending_gate', 'scheduling_inbound_hook']);
  });
});
