import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();
const getByKeyMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  factsRepo: {
    upsert: upsertMock,
    getByKey: getByKeyMock,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  upsertMock.mockReset();
  getByKeyMock.mockReset();
  getByKeyMock.mockResolvedValue(null);
});

describe('recordLLMCost — per-pessoa breakdown', () => {
  it('writes ONLY the global aggregate when pessoa_id is undefined', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0]![0].escopo).toBe('global');
    expect(upsertMock.mock.calls[0]![0].chave).toMatch(/^cost\.daily\.llm\.\d{4}-\d{2}-\d{2}$/);
  });

  it('writes BOTH global + pessoa entries when pessoa_id is provided', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tokens_input: 1000,
      tokens_output: 1000,
      pessoa_id: 'p1',
    });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    const escopos = upsertMock.mock.calls.map((c) => c[0].escopo);
    expect(escopos).toContain('global');
    expect(escopos).toContain('pessoa');
    const pessoaCall = upsertMock.mock.calls.find((c) => c[0].escopo === 'pessoa')!;
    expect(pessoaCall[0].chave).toMatch(/^cost\.daily\.llm\.\d{4}-\d{2}-\d{2}\.p1$/);
    // Same delta on both keys.
    expect(pessoaCall[0].valor.tokens_input).toBe(1000);
    expect(pessoaCall[0].valor.tokens_output).toBe(1000);
  });

  it('readDailyLLMUsdByPessoa returns 0 when no fact exists', async () => {
    const { readDailyLLMUsdByPessoa } = await import('../../src/lib/cost-ledger.js');
    expect(await readDailyLLMUsdByPessoa('p1', '2026-05-08')).toBe(0);
  });

  it('readDailyLLMUsdByPessoa converts cents to USD', async () => {
    getByKeyMock.mockResolvedValueOnce({ valor: { usd_cents: 250 } });
    const { readDailyLLMUsdByPessoa } = await import('../../src/lib/cost-ledger.js');
    expect(await readDailyLLMUsdByPessoa('p1', '2026-05-08')).toBe(2.5);
    expect(getByKeyMock).toHaveBeenCalledWith('pessoa', 'cost.daily.llm.2026-05-08.p1');
  });
});
