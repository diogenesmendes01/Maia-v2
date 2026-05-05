import { describe, it, expect, vi, beforeEach } from 'vitest';

const factsGetByKeyMock = vi.fn();
const factsUpsertMock = vi.fn();
const getModelPricingMock = vi.fn();
const loggerWarn = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  factsRepo: {
    getByKey: factsGetByKeyMock,
    upsert: factsUpsertMock,
  },
}));

vi.mock('../../src/lib/openrouter-pricing.js', () => ({
  getModelPricing: getModelPricingMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  factsGetByKeyMock.mockReset();
  factsUpsertMock.mockReset();
  getModelPricingMock.mockReset();
  loggerWarn.mockClear();
  factsGetByKeyMock.mockResolvedValue(null);
  factsUpsertMock.mockResolvedValue(undefined);
});

const PESSOA_ID = '11111111-1111-1111-1111-111111111111';

describe('cost-ledger.recordLLMCost', () => {
  it('without pessoa_id writes only the global daily aggregate', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tokens_input: 1000,
      tokens_output: 500,
    });
    expect(getModelPricingMock).not.toHaveBeenCalled();
    expect(factsUpsertMock).toHaveBeenCalledTimes(1);
    const arg = factsUpsertMock.mock.calls[0]![0];
    expect(arg.escopo).toBe('global');
    expect(arg.chave).toMatch(/^cost\.daily\.llm\.\d{4}-\d{2}-\d{2}$/);
    // 1000/1000 * 0.3 + 500/1000 * 1.5 = 0.3 + 0.75 = 1.05 cents
    expect(arg.valor.usd_cents).toBeCloseTo(1.05, 4);
    expect(arg.valor.tokens_input).toBe(1000);
    expect(arg.valor.tokens_output).toBe(500);
    expect(arg.valor.last_model).toBe('claude-sonnet-4-6');
  });

  it('with pessoa_id writes BOTH the global aggregate AND a per-pessoa fact', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_input: 2000,
      tokens_output: 1000,
      pessoa_id: PESSOA_ID,
    });
    expect(factsUpsertMock).toHaveBeenCalledTimes(2);
    const escopos = factsUpsertMock.mock.calls.map((c) => c[0].escopo);
    expect(escopos).toContain('global');
    expect(escopos).toContain('pessoa');
    const pessoaCall = factsUpsertMock.mock.calls.find((c) => c[0].escopo === 'pessoa')!;
    expect(pessoaCall[0].chave).toMatch(
      new RegExp(`^cost\\.daily\\.llm\\.\\d{4}-\\d{2}-\\d{2}\\.${PESSOA_ID}$`),
    );
    expect(pessoaCall[0].valor.pessoa_id).toBe(PESSOA_ID);
    // 2000/1000 * 0.08 + 1000/1000 * 0.4 = 0.16 + 0.4 = 0.56 cents
    expect(pessoaCall[0].valor.usd_cents).toBeCloseTo(0.56, 4);
  });

  it('uses the live OpenRouter pricing for slugs that contain a /', async () => {
    getModelPricingMock.mockResolvedValueOnce({ input: 0.02, output: 0.05 });
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'openrouter',
      model: 'x-ai/grok-4.1-fast',
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    expect(getModelPricingMock).toHaveBeenCalledWith('x-ai/grok-4.1-fast');
    const arg = factsUpsertMock.mock.calls[0]![0];
    // 1M/1k * 0.02 + 1M/1k * 0.05 = 20 + 50 = 70 cents
    expect(arg.valor.usd_cents).toBeCloseTo(70, 2);
  });

  it('falls back to the local hardcoded map for non-OpenRouter known models', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    expect(getModelPricingMock).not.toHaveBeenCalled();
    const arg = factsUpsertMock.mock.calls[0]![0];
    // 1000/1000 * 1.5 + 1000/1000 * 7.5 = 9 cents
    expect(arg.valor.usd_cents).toBeCloseTo(9, 4);
  });

  it('falls back to the generic default for unknown slugs without a /', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'totally-unknown-model',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    expect(getModelPricingMock).not.toHaveBeenCalled();
    const arg = factsUpsertMock.mock.calls[0]![0];
    // DEFAULT_RATE = { input: 0.3, output: 1.5 } -> 0.3 + 1.5 = 1.8 cents
    expect(arg.valor.usd_cents).toBeCloseTo(1.8, 4);
  });

  it('falls back to the local map when the OpenRouter slug is not in the cache', async () => {
    getModelPricingMock.mockResolvedValueOnce(null);
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'openrouter',
      model: 'unknown-vendor/unknown-model',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    expect(getModelPricingMock).toHaveBeenCalledOnce();
    const arg = factsUpsertMock.mock.calls[0]![0];
    // Falls through to DEFAULT_RATE since the slug isn't in the local map either.
    expect(arg.valor.usd_cents).toBeCloseTo(1.8, 4);
  });

  it('accumulates over an existing fact (sum of usd_cents and tokens)', async () => {
    factsGetByKeyMock.mockResolvedValueOnce({
      valor: { tokens_input: 100, tokens_output: 50, usd_cents: 0.5 },
    });
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tokens_input: 1000,
      tokens_output: 500,
    });
    const arg = factsUpsertMock.mock.calls[0]![0];
    expect(arg.valor.tokens_input).toBe(1100);
    expect(arg.valor.tokens_output).toBe(550);
    // 0.5 + 1.05 = 1.55
    expect(arg.valor.usd_cents).toBeCloseTo(1.55, 4);
  });

  it('swallows storage errors and only logs a warning', async () => {
    factsUpsertMock.mockRejectedValueOnce(new Error('db down'));
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await expect(
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 100,
        tokens_output: 100,
      }),
    ).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'db down' }),
      'cost_ledger.llm_failed',
    );
  });
});
