/**
 * P09 / G1 — a referência ao exemplo de origem SOBREVIVE à troca de caminho.
 *
 * O caminho que o `LearningService` substituiu gravava
 * `learned_rules.exemplo_origem_id = cluster.signals[0]?.alvo_id`. Ao trocar
 * `rulesRepo.create` por `proposeFromWorker`, essa referência sumiu: a
 * linhagem passou a ser só contada no log, e o revisor humano ficaria com a
 * proposta sem o caso concreto que a motivou — justamente a evidência de que
 * ele precisa para decidir.
 *
 * Estes casos travam os dois trechos da cadeia: o serviço monta o `native`, e
 * o `native` chega ao repositório com o valor certo.
 *
 * Um detalhe de semântica que o arquivo também prende: o id é `transacoes.id`
 * (o `alvo_id` do sinal), NÃO `audit_log.id`. Foi por isso que o campo de
 * entrada se chama `source_example_ids` e não `source_event_ids` — o nome
 * antigo mandaria o consumidor procurar na tabela errada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Capturado = { native?: Record<string, unknown>; lifecycle_status: string };
const capturado: Capturado[] = [];

vi.mock('@/control-plane/knowledge-state-machine/index.js', () => ({
  KnowledgeStateMachine: {
    propose: vi.fn(async (input: { native?: Record<string, unknown>; kind: string }) => {
      capturado.push({ native: input.native, lifecycle_status: 'pending_review' });
      return {
        proposal_id: '11111111-1111-4111-8111-111111111111',
        initial_status: 'pending_review',
        visible_to_llm: false,
        reason: 'risk=low | kind=rule | conf=0.50',
      };
    }),
  },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { proposeFromWorker } = await import('@/learning/service.js');

const EXEMPLO_A = '22222222-2222-4222-8222-222222222222';
const EXEMPLO_B = '33333333-3333-4333-8333-333333333333';

function base() {
  return {
    kind: 'learned_rule' as const,
    tenant_id: 'tenant-a',
    agent_id: 'agent-a',
    trace_id: 't',
    key: 'k',
    content: {},
    content_text: 'texto',
    source: 'worker' as const,
    source_example_ids: [EXEMPLO_A, EXEMPLO_B],
  };
}

beforeEach(() => {
  capturado.length = 0;
  vi.clearAllMocks();
});

describe('proposeFromWorker — a linhagem chega ao destino durável', () => {
  it('o exemplo representativo desce para `rule_exemplo_origem_id`', async () => {
    await proposeFromWorker(base());
    expect(capturado[0]?.native?.['rule_exemplo_origem_id']).toBe(EXEMPLO_A);
  });

  it('o chamador pode escolher qual exemplo representa a proposta', async () => {
    // A coluna guarda UM, e quem sabe qual caso explica melhor é o chamador.
    await proposeFromWorker({ ...base(), primary_example_id: EXEMPLO_B });
    expect(capturado[0]?.native?.['rule_exemplo_origem_id']).toBe(EXEMPLO_B);
  });

  it('os nativos da regra continuam passando junto, não são sobrescritos', async () => {
    await proposeFromWorker({
      ...base(),
      native: { rule_tipo: 'tom_resposta', rule_contexto: 'cliente bravo' },
    });
    expect(capturado[0]?.native).toMatchObject({
      rule_tipo: 'tom_resposta',
      rule_contexto: 'cliente bravo',
      rule_exemplo_origem_id: EXEMPLO_A,
    });
  });

  it('proposta sem linhagem é recusada antes de tocar o KSM', async () => {
    const r = await proposeFromWorker({ ...base(), source_example_ids: [] });
    expect(r).toMatchObject({ kind: 'refused', reason: 'empty_lineage' });
    expect(capturado).toHaveLength(0);
  });
});
