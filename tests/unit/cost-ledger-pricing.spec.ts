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

const getToolCallingModelsMock = vi.fn();
vi.mock('../../src/lib/openrouter-models.js', () => ({
  getToolCallingModels: getToolCallingModelsMock,
}));

beforeEach(() => {
  upsertMock.mockReset();
  getByKeyMock.mockReset();
  getByKeyMock.mockResolvedValue(null);
  getToolCallingModelsMock.mockReset();
});

describe('recordLLMCost — per-OpenRouter-model pricing', () => {
  it('uses live OpenRouter pricing for slugs with "/"', async () => {
    getToolCallingModelsMock.mockResolvedValue([
      {
        id: 'openai/gpt-5',
        name: 'OpenAI: GPT-5',
        context_length: 200000,
        // $5/M input, $15/M output → 0.5¢/1k input, 1.5¢/1k output
        pricing: { prompt_per_million: 5, completion_per_million: 15 },
        supports_tools: true,
      },
    ]);
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'openrouter',
      model: 'openai/gpt-5',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    expect(upsertMock).toHaveBeenCalledOnce();
    const arg = upsertMock.mock.calls[0]![0];
    // 1k * 0.5¢ + 1k * 1.5¢ = 2¢
    expect(arg.valor.usd_cents).toBeCloseTo(2, 5);
    expect(arg.valor.last_model).toBe('openai/gpt-5');
  });

  it('uses local hardcoded rate for direct-vendor model names (no slash)', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6', // hardcoded: 0.3¢ in / 1.5¢ out
      tokens_input: 1000,
      tokens_output: 1000,
    });
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.valor.usd_cents).toBeCloseTo(1.8, 5);
    // Importantly: never hit OpenRouter for direct vendor calls.
    expect(getToolCallingModelsMock).not.toHaveBeenCalled();
  });

  it('falls back to conservative default when OpenRouter slug is unknown', async () => {
    getToolCallingModelsMock.mockResolvedValue([]); // empty catalog
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'openrouter',
      model: 'unknown-vendor/never-seen-model',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    const arg = upsertMock.mock.calls[0]![0];
    // Fallback is 0.3¢ in / 1.5¢ out → 1.8¢ for 1k+1k
    expect(arg.valor.usd_cents).toBeCloseTo(1.8, 5);
  });

  it('falls back when getToolCallingModels rejects (network down + no cache)', async () => {
    getToolCallingModelsMock.mockRejectedValue(new Error('network down'));
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await recordLLMCost({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      tokens_input: 1000,
      tokens_output: 1000,
    });
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.valor.usd_cents).toBeCloseTo(1.8, 5);
  });
});
