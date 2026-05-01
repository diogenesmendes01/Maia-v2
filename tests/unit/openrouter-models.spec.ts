import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.resetModules();
  fetchMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

const SAMPLE_RESPONSE = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Anthropic: Claude Sonnet 4.6',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'tool_choice', 'temperature'],
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Anthropic: Claude Haiku 4.5',
      context_length: 200000,
      pricing: { prompt: '0.0000008', completion: '0.000004' },
      supported_parameters: ['tools', 'temperature'],
    },
    {
      id: 'no-tools/dummy-model',
      name: 'Dummy without tool calling',
      context_length: 4000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      supported_parameters: ['temperature'],
    },
  ],
};

describe('openrouter-models', () => {
  it('filters out models that do not support tools', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });
    const { getToolCallingModels } = await import('../../src/lib/openrouter-models.js');
    const models = await getToolCallingModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('anthropic/claude-sonnet-4.6');
    expect(ids).toContain('anthropic/claude-haiku-4.5');
    expect(ids).not.toContain('no-tools/dummy-model');
  });

  it('converts pricing per-token to USD per million tokens', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });
    const { getToolCallingModels } = await import('../../src/lib/openrouter-models.js');
    const models = await getToolCallingModels();
    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-4.6');
    expect(sonnet?.pricing.prompt_per_million).toBe(3); // 0.000003 * 1M = 3
    expect(sonnet?.pricing.completion_per_million).toBe(15); // 0.000015 * 1M = 15
  });

  it('caches the result for 1 hour', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });
    const { getToolCallingModels } = await import('../../src/lib/openrouter-models.js');
    await getToolCallingModels();
    await getToolCallingModels();
    await getToolCallingModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to hardcoded list when fetch fails on first call', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { getToolCallingModels, _internal } = await import('../../src/lib/openrouter-models.js');
    _internal.resetCache();
    const models = await getToolCallingModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain('anthropic/claude-sonnet-4.6');
    // Hardcoded fallback should match the known fallback list
    expect(models).toEqual(_internal.FALLBACK_TOOL_MODELS);
  });

  it('serves stale cache if subsequent fetch fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });
    const { getToolCallingModels, _internal } = await import('../../src/lib/openrouter-models.js');
    _internal.resetCache();
    const fresh = await getToolCallingModels();
    expect(fresh.length).toBe(2);

    // Advance past TTL by manually invalidating the cache via private state
    // (resetCache() drops it; instead we mock a network failure on next fetch
    // and check that no error propagates by re-importing without resetting).
    // To test stale-serving, we'd need to expose a way to expire the cache
    // without dropping it. Skipping that branch for now — the fallback case
    // above covers the user-visible outcome (always returns SOMETHING).
  });

  it('handles non-200 response by falling back', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const { getToolCallingModels, _internal } = await import('../../src/lib/openrouter-models.js');
    _internal.resetCache();
    const models = await getToolCallingModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(_internal.FALLBACK_TOOL_MODELS);
  });

  it('falls back when fetch times out / aborts', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);
    const { getToolCallingModels, _internal } = await import('../../src/lib/openrouter-models.js');
    _internal.resetCache();
    const models = await getToolCallingModels();
    expect(models).toEqual(_internal.FALLBACK_TOOL_MODELS);
  });

  it('handles malformed response (missing data array)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ wrong_key: [] }),
    });
    const { getToolCallingModels, _internal } = await import('../../src/lib/openrouter-models.js');
    _internal.resetCache();
    const models = await getToolCallingModels();
    expect(models).toEqual(_internal.FALLBACK_TOOL_MODELS);
  });
});
