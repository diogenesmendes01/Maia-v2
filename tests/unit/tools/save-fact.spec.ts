import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveFactInMemoryMock = vi.fn();

vi.mock('../../../src/memory/semantic.js', () => ({
  saveFact: saveFactInMemoryMock,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  saveFactInMemoryMock.mockReset();
});

const PESSOA_ID = '11111111-1111-1111-1111-111111111111';
const E1 = '22222222-2222-2222-2222-222222222222';
const E_OUT = '33333333-3333-3333-3333-333333333333';

const ctx = {
  pessoa: { id: PESSOA_ID },
  conversa: { id: 'c1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('save_fact tool', () => {
  it('happy path: persists a fact under entidade scope and returns fact_id', async () => {
    saveFactInMemoryMock.mockResolvedValueOnce({ id: 'fact-uuid-1' });
    const { saveFactTool } = await import('../../../src/tools/save-fact.js');
    const result = await saveFactTool.handler(
      {
        escopo: `entidade:${E1}`,
        chave: 'preferencia.fornecedor',
        valor: { nome: 'ACME' },
        fonte: 'aprendido',
        confianca: 0.8,
      } as never,
      ctx,
    );
    expect(result).toEqual({ fact_id: 'fact-uuid-1' });
    expect(saveFactInMemoryMock).toHaveBeenCalledWith({
      escopo: `entidade:${E1}`,
      chave: 'preferencia.fornecedor',
      valor: { nome: 'ACME' },
      fonte: 'aprendido',
      confianca: 0.8,
    });
  });

  it('schema invalid: rejects malformed escopo', async () => {
    const { saveFactTool } = await import('../../../src/tools/save-fact.js');
    const parsed = saveFactTool.input_schema.safeParse({
      escopo: 'lixo:invalido',
      chave: 'k',
      valor: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects entidade scope outside caller scope (cross-entity guard)', async () => {
    const { saveFactTool } = await import('../../../src/tools/save-fact.js');
    await expect(
      saveFactTool.handler(
        {
          escopo: `entidade:${E_OUT}`,
          chave: 'k',
          valor: 1,
          fonte: 'aprendido',
        } as never,
        ctx,
      ),
    ).rejects.toThrow('escopo_outside_scope');
    expect(saveFactInMemoryMock).not.toHaveBeenCalled();
  });

  it('rejects pessoa scope when pessoa_id does not match caller', async () => {
    const { saveFactTool } = await import('../../../src/tools/save-fact.js');
    await expect(
      saveFactTool.handler(
        {
          escopo: 'pessoa:99999999-9999-9999-9999-999999999999',
          chave: 'k',
          valor: 1,
          fonte: 'aprendido',
        } as never,
        ctx,
      ),
    ).rejects.toThrow('escopo_outside_scope');
    expect(saveFactInMemoryMock).not.toHaveBeenCalled();
  });
});
