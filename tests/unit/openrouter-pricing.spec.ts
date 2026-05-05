import { describe, it, expect, vi, beforeEach } from 'vitest';

const getToolCallingModelsMock = vi.fn();
const loggerWarn = vi.fn();

vi.mock('../../src/lib/openrouter-models.js', () => ({
  getToolCallingModels: getToolCallingModelsMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  getToolCallingModelsMock.mockReset();
  loggerWarn.mockClear();
});

const SAMPLE_MODELS = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Anthropic: Claude Sonnet 4.6',
    context_length: 200000,
    pricing: { prompt_per_million: 3, completion_per_million: 15 },
    supports_tools: true,
  },
  {
    id: 'x-ai/grok-4.1-fast',
    name: 'xAI: Grok 4.1 Fast',
    context_length: 256000,
    pricing: { prompt_per_million: 0.2, completion_per_million: 0.5 },
    supports_tools: true,
  },
];

describe('openrouter-pricing', () => {
  it('converts USD/M tokens to cents/1k tokens for a known slug', async () => {
    getToolCallingModelsMock.mockResolvedValue(SAMPLE_MODELS);
    const { getModelPricing } = await import('../../src/lib/openrouter-pricing.js');
    const p = await getModelPricing('anthropic/claude-sonnet-4.6');
    // $3/M input -> 3/10 = 0.3 cents/1k
    // $15/M output -> 15/10 = 1.5 cents/1k
    expect(p).toEqual({ input: 0.3, output: 1.5 });
  });

  it('handles cheaper models without rounding to zero', async () => {
    getToolCallingModelsMock.mockResolvedValue(SAMPLE_MODELS);
    const { getModelPricing } = await import('../../src/lib/openrouter-pricing.js');
    const p = await getModelPricing('x-ai/grok-4.1-fast');
    // $0.2/M -> 0.02 cents/1k
    expect(p).toEqual({ input: 0.02, output: 0.05 });
  });

  it('returns null for an unknown slug', async () => {
    getToolCallingModelsMock.mockResolvedValue(SAMPLE_MODELS);
    const { getModelPricing } = await import('../../src/lib/openrouter-pricing.js');
    const p = await getModelPricing('does-not/exist');
    expect(p).toBeNull();
  });

  it('returns null and logs a warning when the cache lookup throws', async () => {
    getToolCallingModelsMock.mockRejectedValueOnce(new Error('cache exploded'));
    const { getModelPricing } = await import('../../src/lib/openrouter-pricing.js');
    const p = await getModelPricing('anthropic/claude-sonnet-4.6');
    expect(p).toBeNull();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarn.mock.calls[0]!;
    expect(meta).toMatchObject({ slug: 'anthropic/claude-sonnet-4.6' });
    expect(msg).toBe('openrouter_pricing.lookup_failed');
  });
});
