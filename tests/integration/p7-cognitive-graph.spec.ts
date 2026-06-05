/**
 * P7 Task 10 — Golden regression integration test.
 *
 * **Objetivo:** prova *comportamental* de "user-facing idêntico pré-P7"
 * (spec §9 P7). A defesa primária de não-regressão vem do dual-path em
 * `agent/core.ts` (Task 8, legacy preservado byte-por-byte). Este teste é
 * defesa *adicional* — torna qualquer drift futuro visível.
 *
 * **Escopo:** Option B (smoke + audit-invariant). Option A (golden completo
 * com fixtures de Pessoa/Conversa/Mensagem invocando `runAgentForMensagem`)
 * exige ~200 linhas de mocks só pra subir o agent loop (ver
 * `tests/unit/agent-core-flow.spec.ts`); o spec autoriza Option B quando o
 * custo é alto. Aqui cobrimos:
 *
 *   1. Flag flip (off → on) é honrado pelo singleton featureFlags.
 *   2. callLLM determinístico via mock (base pra extensões futuras).
 *   3. AUDIT INVARIANT: quando o grafo é exercitado, `cognitiveModuleLogRepo.record`
 *      é chamado com um `module_name` que corresponde a um dos 6 nodes
 *      (procedure-selector, role-selector, reasoner, step-evaluator-trigger,
 *      correction-reflection, success-reflection).
 *   4. Composição do grafo difere entre flag ON e OFF (proxy do comportamento:
 *      `buildPreturnNodes` muda quantidade/identidade de nodes conforme
 *      multi_channel_on).
 *   5. Postturn nodes têm runWhen gating (gate de não-regressão: sem trigger,
 *      sem trabalho).
 *
 * **Critério "test must not need Postgres":** este arquivo mocka
 * `@/db/repositories.js` e `@/lib/claude.js`; nenhum tcp/5432 envolvido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitiveLayer } from '@/types/enums.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---- Mock pesado: LLM determinístico. -------------------------------------
// Seed fixa via lookup do último user message. Nenhuma rede.
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async ({ messages }: { messages?: Array<{ role: string; content: string }> }) => {
    const last = messages?.[messages.length - 1]?.content ?? '';
    if (last.includes('saudação')) {
      return {
        content: 'oi! como posso ajudar?',
        tool_uses: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }
    if (last.includes('correção')) {
      return {
        content: 'desculpa, vou corrigir.',
        tool_uses: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }
    return {
      content: 'ok.',
      tool_uses: [],
      usage: { input_tokens: 5, output_tokens: 3 },
    };
  }),
}));

// ---- Mock cognitive_module_log para capturar audit ------------------------
// recordSpy é o gancho central: toda execução de node passa por runCognitiveModule
// → cognitiveModuleLogRepo.record. Capturar = provar que o grafo audita.
const recordSpy = vi.fn(async () => {});
vi.mock('@/db/repositories.js', async () => {
  const actual =
    await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: recordSpy,
      recentByModule: vi.fn(async () => []),
    },
  };
});

// Nomes válidos dos nodes do grafo (espec §9). Audit invariant: pelo menos
// UMA gravação no recordSpy precisa ter module_name ∈ deste set quando o grafo
// é exercitado.
const GRAPH_NODE_NAMES = new Set([
  'procedure-selector',
  'role-selector',
  'reasoner',
  'step-evaluator-trigger',
  'correction-reflection',
  'success-reflection',
]);

describe('P7 — golden regression (graph path audit invariant)', () => {
  // The FEATURE_COGNITIVE_GRAPH flag-flip / kill-switch tests were removed in
  // issue #412 — the cognitive graph now runs unconditionally (parity proven),
  // so there is no toggle to exercise. The audit-invariant, composition and
  // runWhen-gating tests below remain: they assert the (now sole) graph path
  // emits audit rows and gates work correctly.
  beforeEach(() => {
    recordSpy.mockClear();
  });

  // ----- 2. callLLM determinístico ------------------------------------------

  it('callLLM mock responde deterministicamente conforme conteúdo', async () => {
    const { callLLM } = await import('@/lib/claude.js');
    const r1 = await callLLM({
      system: 's',
      messages: [{ role: 'user', content: 'saudação test' }],
    });
    expect(r1.content).toBe('oi! como posso ajudar?');

    const r2 = await callLLM({
      system: 's',
      messages: [{ role: 'user', content: 'correção test' }],
    });
    expect(r2.content).toBe('desculpa, vou corrigir.');

    const r3 = await callLLM({
      system: 's',
      messages: [{ role: 'user', content: 'qualquer outro' }],
    });
    expect(r3.content).toBe('ok.');
  });

  // ----- 3. AUDIT INVARIANT (núcleo do golden test) -------------------------

  it('AUDIT INVARIANT — runNodes em preturn graph dispara cognitiveModuleLogRepo.record com module_name de graph node', async () => {
    const { runNodes } = await import('@/cognitive-graph/orchestrator.js');
    const { buildPreturnNodes } = await import('@/cognitive-graph/preturn-graph.js');

    // Tenant context obrigatório (runCognitiveModule lê via tryGetCurrentContext).
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const nodes = buildPreturnNodes({ multi_channel_on: false });
      // Replace run() de cada node com fallback determinístico — não precisamos
      // de mocks dos cognition modules reais; só do contrato: runNodes →
      // runCognitiveModule → recordSpy.
      const stubbedNodes = nodes.map((n) => ({
        ...n,
        run: async () => ({ decision: 'none', candidates: [], conflicts: [], reason: 'stub' }),
      }));
      await runNodes(stubbedNodes, {
        conversa_id: 'c-test',
        turno_id: 't-test',
        inbound_text: 'saudação',
        current_execution: null,
      } as never);
    });

    // Audit gravado.
    expect(recordSpy).toHaveBeenCalled();

    // Pelo menos uma das gravações tem module_name conhecido do grafo.
    const calls = recordSpy.mock.calls;
    const recordedNames = calls.map((c) => (c[0] as { module_name: string }).module_name);
    const someValidNode = recordedNames.some((name) => GRAPH_NODE_NAMES.has(name));
    expect(someValidNode).toBe(true);
  });

  it('AUDIT INVARIANT — runNodes em postturn graph (ASYNC) também dispara audit (fire-and-forget)', async () => {
    const { runNodes } = await import('@/cognitive-graph/orchestrator.js');
    const { buildPostturnNodes } = await import('@/cognitive-graph/postturn-graph.js');

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const nodes = buildPostturnNodes();
      // Stub run() pra evitar dependência de reflection/procedure engine reais.
      // runWhen: força true em todos pra garantir que os 3 nodes disparem.
      const stubbedNodes = nodes.map((n) => ({
        ...n,
        runWhen: () => true,
        run: async () => 'ok',
      }));
      await runNodes(stubbedNodes, {
        conversa_id: 'c-test',
        turno_id: 't-test',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-test' },
        inbound: { id: 't-test', conteudo: 'obrigado!' },
        response_text: 'ok.',
        tools_called: [],
        active_execution_id: null,
      } as never);

      // ASYNC: runNodes retorna placeholder imediato; o audit acontece dentro
      // da promise fire-and-forget. Espera um tick pra ela completar.
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(recordSpy).toHaveBeenCalled();
    const recordedNames = recordSpy.mock.calls.map(
      (c) => (c[0] as { module_name: string }).module_name,
    );
    const matchedNodes = recordedNames.filter((name) => GRAPH_NODE_NAMES.has(name));
    expect(matchedNodes.length).toBeGreaterThan(0);
  });

  // ----- 4. Composição do grafo difere conforme flag ------------------------

  it('buildPreturnNodes: multi_channel_on=false omite role-selector (gate compat P6)', async () => {
    const { buildPreturnNodes } = await import('@/cognitive-graph/preturn-graph.js');
    const off = buildPreturnNodes({ multi_channel_on: false });
    const on = buildPreturnNodes({ multi_channel_on: true });
    expect(off.map((n) => n.name)).not.toContain('role-selector');
    expect(on.map((n) => n.name)).toContain('role-selector');
    // procedure-selector existe nos dois (independente de multi_channel).
    expect(off.map((n) => n.name)).toContain('procedure-selector');
    expect(on.map((n) => n.name)).toContain('procedure-selector');
  });

  // ----- 5. Postturn nodes têm runWhen gating ------------------------------

  it('postturn nodes têm runWhen — sem trigger, sem trabalho (não-regressão)', async () => {
    const { buildPostturnNodes } = await import('@/cognitive-graph/postturn-graph.js');
    const nodes = buildPostturnNodes();
    expect(nodes.length).toBe(3);
    nodes.forEach((n) => {
      expect(typeof n.runWhen).toBe('function');
      expect(n.layer).toBe(CognitiveLayer.ASYNC);
    });
  });

  // ----- 6. SKIPPED node NÃO grava audit (princípio: skip ≠ run) -----------

  it('runWhen=false: node fica SKIPPED e NÃO chama cognitiveModuleLogRepo.record', async () => {
    const { runNodes } = await import('@/cognitive-graph/orchestrator.js');
    const { buildPostturnNodes } = await import('@/cognitive-graph/postturn-graph.js');

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const nodes = buildPostturnNodes();
      // runWhen → false em todos. Stubs de run() não devem ser chamados.
      const stubbedNodes = nodes.map((n) => ({
        ...n,
        runWhen: () => false,
        run: vi.fn(async () => 'should not run'),
      }));
      await runNodes(stubbedNodes, {
        conversa_id: 'c-test',
        turno_id: 't-test',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-test' },
        inbound: { id: 't-test', conteudo: '' },
        response_text: '',
        tools_called: [],
        active_execution_id: null,
      } as never);
      await new Promise((r) => setTimeout(r, 50));
    });

    // SKIPPED não grava audit (orchestrator §70: runWhen=false → return cedo
    // antes de runCognitiveModule).
    const skippedNames = recordSpy.mock.calls
      .map((c) => (c[0] as { module_name: string }).module_name)
      .filter((name) => GRAPH_NODE_NAMES.has(name));
    expect(skippedNames).toEqual([]);
  });
});
