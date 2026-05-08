import { describe, it, expect, vi, beforeEach } from 'vitest';

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const rulesRepoCreate = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  rulesRepo: { create: rulesRepoCreate },
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
});

describe('reflectOnCorrection — per-pessoa cost attribution', () => {
  it('forwards pessoa_id to callLLM so the cost lands under the right pessoa', async () => {
    callLLM.mockResolvedValueOnce({
      content: '{"applicable":false}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    const { reflectOnCorrection } = await import('../../src/agent/reflection.js');
    await reflectOnCorrection({ pessoa, conversa, inbound, previousAssistant });
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(callLLM.mock.calls[0]![0].pessoa_id).toBe('p1');
  });

  it('returns early when previousAssistant is null without calling LLM', async () => {
    const { reflectOnCorrection } = await import('../../src/agent/reflection.js');
    await reflectOnCorrection({ pessoa, conversa, inbound, previousAssistant: null });
    expect(callLLM).not.toHaveBeenCalled();
  });
});
