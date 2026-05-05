import { describe, it, expect, vi, beforeEach } from 'vitest';

const recallMock = vi.fn();

vi.mock('../../../src/memory/vector.js', () => ({
  recall: recallMock,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  recallMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1', 'e2'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('recall_memory tool', () => {
  it('happy path: returns top-N items projected to {conteudo, tipo, score}', async () => {
    recallMock.mockResolvedValueOnce([
      { conteudo: 'fato A', tipo: 'fact', escopo: 'pessoa:p1', score: 0.92 },
      { conteudo: 'evento B', tipo: 'episode', escopo: 'entidade:e1', score: 0.81 },
    ]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    const result = await recallMemoryTool.handler(
      { query: 'mercado mes passado', k: 5 } as never,
      ctx,
    );
    expect(result).toEqual({
      items: [
        { conteudo: 'fato A', tipo: 'fact', score: 0.92 },
        { conteudo: 'evento B', tipo: 'episode', score: 0.81 },
      ],
    });
    expect(recallMock).toHaveBeenCalledTimes(1);
    const call = recallMock.mock.calls[0]![0] as {
      query: string;
      escopo: string[];
      k: number;
    };
    expect(call.query).toBe('mercado mes passado');
    expect(call.k).toBe(5);
    // Scope must include global, pessoa:<id> and one entry per entidade.
    expect(call.escopo).toEqual(
      expect.arrayContaining(['global', 'pessoa:p1', 'entidade:e1', 'entidade:e2']),
    );
  });

  it('schema invalid: empty query is rejected by zod', async () => {
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    const parsed = recallMemoryTool.input_schema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('returns empty list when underlying recall returns no matches (e.g. no embedding)', async () => {
    // recall() falls back to [] when the embedding provider yields nothing
    // or pgvector errors out — handler must propagate that as an empty list.
    recallMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    const result = await recallMemoryTool.handler(
      { query: 'algo bem obscuro', k: 3 } as never,
      ctx,
    );
    expect(result).toEqual({ items: [] });
  });
});
