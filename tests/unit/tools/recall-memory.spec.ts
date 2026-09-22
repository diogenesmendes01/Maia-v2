/**
 * `recall_memory` — a ferramenta, depois do G2 (spec §7.6.3).
 *
 * ─── O que esta versão substituiu ───────────────────────────────────────────
 *
 * A anterior afirmava que a ferramenta montava uma lista de escopos e a
 * passava ao recall, e checava nominalmente que a lista continha `'global'`,
 * `pessoa:<id>` e uma entrada por entidade:
 *
 *     expect(call.escopo).toEqual(
 *       expect.arrayContaining(['global', 'pessoa:p1', 'entidade:e1', 'entidade:e2']),
 *     );
 *
 * Ou seja: ela PINAVA o defeito. A lista não era filtro — era a autorização
 * inteira, escrita pelo chamador —, e `'global'` nela devolvia memória de
 * escopo global para qualquer interlocutor, sem ninguém ter publicado nada. A
 * spec é literal: "Não exportar `escopo:string[]` como autorização."
 *
 * Agora a ferramenta passa um PRINCIPAL, e quem decide é o predicado do
 * §7.6.3, dentro do SQL. Os casos abaixo prendem o contrato novo — e o
 * primeiro grupo existe para que o antigo não volte por descuido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recallAuthorizedMock = vi.fn();

vi.mock('../../../src/memory/recall-authorized.js', () => ({
  recallAuthorized: recallAuthorizedMock,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  recallAuthorizedMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1', 'e2'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('recall_memory — a autorização não é mais argumento', () => {
  it('passa o PRINCIPAL, não uma lista de escopos', async () => {
    recallAuthorizedMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    await recallMemoryTool.handler({ query: 'mercado mes passado', k: 5 } as never, ctx);

    const call = recallAuthorizedMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.principal).toEqual({ pessoa_id: 'p1', conversa_id: 'c1' });
    // O campo que carregava a autorização não existe mais.
    expect(call).not.toHaveProperty('escopo');
  });

  it('`global` NÃO é mais alcançável pela ferramenta', async () => {
    // Era o pior efeito da lista: memória de escopo global voltava para
    // qualquer interlocutor, sem publicação nenhuma.
    recallAuthorizedMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    await recallMemoryTool.handler({ query: 'q', k: 3 } as never, ctx);
    expect(JSON.stringify(recallAuthorizedMock.mock.calls[0])).not.toContain('global');
  });

  it('as ENTIDADES do escopo não entram: memória é do titular', async () => {
    // Uma entidade não é titular de dado pessoal. Projetar por entidade
    // devolveria a memória de uma pessoa a quem tem acesso à empresa dela.
    recallAuthorizedMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    await recallMemoryTool.handler({ query: 'q', k: 3 } as never, ctx);
    const serializado = JSON.stringify(recallAuthorizedMock.mock.calls[0]);
    expect(serializado).not.toContain('e1');
    expect(serializado).not.toContain('e2');
  });

  it('a conversa vai junto: item preso a uma conversa não vaza para outra', async () => {
    recallAuthorizedMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    await recallMemoryTool.handler({ query: 'q', k: 3 } as never, ctx);
    const call = recallAuthorizedMock.mock.calls[0]![0] as {
      principal: { conversa_id: string };
    };
    expect(call.principal.conversa_id).toBe('c1');
  });
});

describe('recall_memory — a projeção de saída', () => {
  it('projeta o conteúdo CANÔNICO para {conteudo, tipo, score}', async () => {
    // O serviço devolve `content`/`memory_type` — os campos da linha canônica,
    // não da cópia denormalizada do vetor. A ferramenta reprojeta para o
    // formato que o modelo já conhece.
    recallAuthorizedMock.mockResolvedValueOnce([
      { memory_entry_id: 'm-1', content: 'fato A', memory_type: 'fact', score: 0.92 },
      { memory_entry_id: 'm-2', content: 'evento B', memory_type: 'episode', score: 0.81 },
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
  });

  it('o id canônico NÃO é exposto ao modelo', async () => {
    // Ele serve para auditoria e reconciliação do lado de cá; devolvê-lo ao
    // modelo daria a ele uma referência que ele não tem como usar e que
    // vazaria estrutura interna no prompt seguinte.
    recallAuthorizedMock.mockResolvedValueOnce([
      { memory_entry_id: 'm-1', content: 'x', memory_type: 'fact', score: 0.5 },
    ]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    const result = (await recallMemoryTool.handler({ query: 'q', k: 1 } as never, ctx)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items[0]).not.toHaveProperty('memory_entry_id');
  });

  it('lista vazia quando nada é autorizado', async () => {
    // O serviço devolve `[]` tanto para "não achou" quanto para "falhou a
    // leitura" — e nos dois casos a resposta honesta é lista vazia, nunca
    // resultado parcial.
    recallAuthorizedMock.mockResolvedValueOnce([]);
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    const result = await recallMemoryTool.handler(
      { query: 'algo bem obscuro', k: 3 } as never,
      ctx,
    );
    expect(result).toEqual({ items: [] });
  });

  it('schema invalid: empty query is rejected by zod', async () => {
    const { recallMemoryTool } = await import('../../../src/tools/recall-memory.js');
    expect(recallMemoryTool.input_schema.safeParse({ query: '' }).success).toBe(false);
  });
});
