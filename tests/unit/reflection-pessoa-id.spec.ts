import { describe, it, expect, vi, beforeEach } from 'vitest';

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const rulesRepoCreate = vi.fn();
const factsRepoUpsert = vi.fn();
const cognitiveCandidatesRepoCreate = vi.fn();
const cognitiveModuleLogRepoRecord = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  rulesRepo: { create: rulesRepoCreate },
  factsRepo: { upsert: factsRepoUpsert },
  cognitiveCandidatesRepo: { create: cognitiveCandidatesRepoCreate },
  cognitiveModuleLogRepo: { record: cognitiveModuleLogRepoRecord },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const pessoa = { id: 'p1' } as never;
const conversa = { id: 'c1' } as never;
const inbound = { id: 'm1', conteudo: 'errado, era outra categoria' } as never;
const previousAssistant = {
  id: 'm0',
  conteudo: 'Lancei R$ 50 em Mercado',
} as never;

beforeEach(() => {
  callLLM.mockReset();
  rulesRepoCreate.mockReset();
  factsRepoUpsert.mockReset();
  cognitiveCandidatesRepoCreate.mockReset();
  cognitiveModuleLogRepoRecord.mockReset();
});

describe('reflectOnCorrection — per-pessoa cost attribution', () => {
  it('forwards pessoa_id to callLLM (Reflector stage) so the cost lands under the right pessoa', async () => {
    // Reflector call: retorna insight bruto que o Classifier vai descartar.
    callLLM.mockResolvedValueOnce({
      content: 'DESCARTE: correção não aplicável',
      usage: { input_tokens: 5, output_tokens: 5 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    // Classifier call: tipa como descarte → Persister só loga, não chama repos.
    callLLM.mockResolvedValueOnce({
      content: '{"type":"descarte","reason":"nao aplicavel"}',
      usage: { input_tokens: 5, output_tokens: 5 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });

    const { reflectOnCorrection } = await import('../../src/agent/reflection.js');
    await reflectOnCorrection({ pessoa, conversa, inbound, previousAssistant });

    // Pipeline novo dispara 2 chamadas LLM: Reflector + Classifier.
    expect(callLLM).toHaveBeenCalledTimes(2);
    // pessoa_id é propagado APENAS na chamada do Reflector (atribuição de custo
    // por pessoa). Classifier é estrutural e não carrega pessoa.
    expect(callLLM.mock.calls[0]![0].pessoa_id).toBe('p1');
    expect(callLLM.mock.calls[1]![0].pessoa_id).toBeUndefined();
  });

  it('returns early when previousAssistant is null without calling LLM', async () => {
    const { reflectOnCorrection } = await import('../../src/agent/reflection.js');
    await reflectOnCorrection({ pessoa, conversa, inbound, previousAssistant: null });
    expect(callLLM).not.toHaveBeenCalled();
  });
});
