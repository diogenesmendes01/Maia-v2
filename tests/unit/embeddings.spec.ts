/**
 * Embedding-provider switch — proves config.EMBEDDING_PROVIDER selects the
 * right adapter, that the runtime DimensionGuard rejects vectors of the
 * wrong size, and that provider/model mismatches fall back to the safe
 * default per spec 08 §9.3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

beforeEach(() => {
  fetchMock.mockReset();
});

async function loadWithConfig(cfg: Record<string, unknown>): Promise<typeof import('../../src/lib/embeddings.js')> {
  vi.resetModules();
  vi.doMock('../../src/config/env.js', () => ({ config: cfg }));
  return await import('../../src/lib/embeddings.js');
}

describe('embeddings — provider factory', () => {
  it('selects voyage when configured', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'voyage',
      EMBEDDING_MODEL: 'voyage-3',
      EMBEDDING_DIMENSIONS: 1024,
      VOYAGE_API_KEY: 'sk-voyage',
    });
    expect(getEmbeddingProvider().name).toBe('voyage');
  });

  it('selects openai when configured', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: 1024,
      OPENAI_API_KEY: 'sk-openai',
    });
    expect(getEmbeddingProvider().name).toBe('openai');
  });

  it('openai text-embedding-3-* requests pass `dimensions` so the API truncates', async () => {
    // Bug fix: previously the OpenAI body was {input, model} only — without
    // `dimensions`, text-embedding-3-small returns 1536 (native) and the
    // downstream guard fires `embedding_dim_mismatch` on the very first embed
    // when EMBEDDING_DIMENSIONS=1024 (matching pgvector schema).
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: 1024,
      OPENAI_API_KEY: 'sk-openai',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(1024).fill(0) }] }),
    });
    await getEmbeddingProvider().embed(['olá']);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.dimensions).toBe(1024);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(['olá']);
  });

  it('openai legacy text-embedding-ada-002 does NOT pass `dimensions` (api would 400)', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-ada-002',
      EMBEDDING_DIMENSIONS: 1536,
      OPENAI_API_KEY: 'sk-openai',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(1536).fill(0) }] }),
    });
    await getEmbeddingProvider().embed(['olá']);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.dimensions).toBeUndefined();
  });

  it('selects cohere when configured', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-multilingual-v3.0',
      EMBEDDING_DIMENSIONS: 1024,
      COHERE_API_KEY: 'co-key',
    });
    expect(getEmbeddingProvider().name).toBe('cohere');
  });

  it('cohere call posts to v1/embed and returns parsed embeddings', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-multilingual-v3.0',
      EMBEDDING_DIMENSIONS: 4,
      COHERE_API_KEY: 'co-key',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3, 0.4]] }),
    });
    const out = await getEmbeddingProvider().embed(['olá']);
    expect(out).toEqual([[0.1, 0.2, 0.3, 0.4]]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cohere.com/v1/embed');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer co-key');
  });

  it('throws on missing API key for the configured provider', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-multilingual-v3.0',
      EMBEDDING_DIMENSIONS: 1024,
    });
    expect(() => getEmbeddingProvider()).toThrow(/COHERE_API_KEY/);
  });
});

describe('embeddings — provider/model mismatch', () => {
  it('falls back to provider default when model belongs to a different provider', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      // Operator forgot to update EMBEDDING_MODEL after switching provider.
      EMBEDDING_MODEL: 'voyage-3',
      EMBEDDING_DIMENSIONS: 1024,
      COHERE_API_KEY: 'co-key',
    });
    const p = getEmbeddingProvider();
    expect(p.name).toBe('cohere');
    // Should NOT have sent voyage-3 to Cohere — the safe default kicks in.
    expect(p.modelId).toBe('embed-multilingual-v3.0');
  });

  it('keeps unknown model as-is (no inference, no fallback)', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'custom-fine-tuned-model',
      EMBEDDING_DIMENSIONS: 1024,
      COHERE_API_KEY: 'co-key',
    });
    expect(getEmbeddingProvider().modelId).toBe('custom-fine-tuned-model');
  });

  it('inferProviderFromModel detects each provider by prefix', async () => {
    const { inferProviderFromModel } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'voyage',
      EMBEDDING_MODEL: 'voyage-3',
      EMBEDDING_DIMENSIONS: 1024,
      VOYAGE_API_KEY: 'sk',
    });
    expect(inferProviderFromModel('voyage-large-2')).toBe('voyage');
    expect(inferProviderFromModel('text-embedding-3-large')).toBe('openai');
    expect(inferProviderFromModel('embed-english-v3.0')).toBe('cohere');
    expect(inferProviderFromModel('weird-name')).toBeNull();
  });
});

describe('embeddings — dimension guard', () => {
  it('throws when a returned vector has the wrong length', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-multilingual-v3.0',
      EMBEDDING_DIMENSIONS: 4,
      COHERE_API_KEY: 'co-key',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      // 5 dims but config expects 4.
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]] }),
    });
    await expect(getEmbeddingProvider().embed(['olá'])).rejects.toThrow(/embedding_dim_mismatch/);
  });

  it('lets valid-dimension vectors through unchanged', async () => {
    const { getEmbeddingProvider } = await loadWithConfig({
      EMBEDDING_PROVIDER: 'cohere',
      EMBEDDING_MODEL: 'embed-multilingual-v3.0',
      EMBEDDING_DIMENSIONS: 3,
      COHERE_API_KEY: 'co-key',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    const out = await getEmbeddingProvider().embed(['olá']);
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
  });
});
