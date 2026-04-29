import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export interface EmbeddingProvider {
  name: 'voyage' | 'openai' | 'cohere';
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Default model per provider. Used when `EMBEDDING_MODEL` is left at its
 * legacy default (`voyage-3`) but the provider is something else — picking
 * the wrong model would otherwise send a Voyage model id to a Cohere
 * endpoint and fail at first call.
 */
const DEFAULT_MODEL_BY_PROVIDER: Record<EmbeddingProvider['name'], string> = {
  voyage: 'voyage-3',
  openai: 'text-embedding-3-small',
  cohere: 'embed-multilingual-v3.0',
};

/** Detect which provider a model id is meant for, by prefix. */
export function inferProviderFromModel(model: string): EmbeddingProvider['name'] | null {
  if (model.startsWith('voyage-')) return 'voyage';
  if (model.startsWith('text-embedding-')) return 'openai';
  if (model.startsWith('embed-')) return 'cohere';
  return null;
}

class VoyageProvider implements EmbeddingProvider {
  name = 'voyage' as const;
  constructor(
    private apiKey: string,
    public modelId: string,
    public dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.modelId }),
    });
    if (!res.ok) throw new Error(`voyage_embed_failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai' as const;
  constructor(
    private apiKey: string,
    public modelId: string,
    public dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.modelId }),
    });
    if (!res.ok) throw new Error(`openai_embed_failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}

class CohereEmbeddingProvider implements EmbeddingProvider {
  name = 'cohere' as const;
  constructor(
    private apiKey: string,
    public modelId: string,
    public dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        texts,
        model: this.modelId,
        // 'search_document' is the most common case for stored memories;
        // recall uses 'search_query' on its own dedicated model when needed.
        input_type: 'search_document',
      }),
    });
    if (!res.ok) throw new Error(`cohere_embed_failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}

/**
 * Wraps a provider to assert that every returned vector has the expected
 * dimension. Without this, a misconfigured `EMBEDDING_DIMENSIONS` would only
 * surface later as an opaque pgvector insert error.
 */
class DimensionGuard implements EmbeddingProvider {
  constructor(
    private inner: EmbeddingProvider,
    public dimensions: number,
  ) {}
  get name(): EmbeddingProvider['name'] {
    return this.inner.name;
  }
  get modelId(): string {
    return this.inner.modelId;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const out = await this.inner.embed(texts);
    for (const v of out) {
      if (v.length !== this.dimensions) {
        throw new Error(
          `embedding_dim_mismatch: ${this.inner.name}/${this.inner.modelId} returned dim=${v.length} but config EMBEDDING_DIMENSIONS=${this.dimensions}`,
        );
      }
    }
    return out;
  }
}

/**
 * Resolve the model id to use, defaulting to the provider's recommended one
 * when the operator left `EMBEDDING_MODEL` at the legacy `voyage-3` default
 * but switched provider.
 */
function resolveModelId(provider: EmbeddingProvider['name'], rawModel: string): string {
  const inferred = inferProviderFromModel(rawModel);
  if (inferred && inferred !== provider) {
    // Provider/model mismatch — fall back to a safe default for the chosen
    // provider rather than send the wrong model id to the wrong API.
    logger.warn(
      {
        configured_model: rawModel,
        configured_model_provider: inferred,
        provider,
        using: DEFAULT_MODEL_BY_PROVIDER[provider],
      },
      'embeddings.model_provider_mismatch_using_default',
    );
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return rawModel;
}

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;
  const model = resolveModelId(config.EMBEDDING_PROVIDER, config.EMBEDDING_MODEL);
  let raw: EmbeddingProvider;
  if (config.EMBEDDING_PROVIDER === 'voyage') {
    if (!config.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY missing');
    raw = new VoyageProvider(config.VOYAGE_API_KEY, model, config.EMBEDDING_DIMENSIONS);
  } else if (config.EMBEDDING_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    raw = new OpenAIEmbeddingProvider(config.OPENAI_API_KEY, model, config.EMBEDDING_DIMENSIONS);
  } else if (config.EMBEDDING_PROVIDER === 'cohere') {
    if (!config.COHERE_API_KEY) throw new Error('COHERE_API_KEY missing');
    raw = new CohereEmbeddingProvider(config.COHERE_API_KEY, model, config.EMBEDDING_DIMENSIONS);
  } else {
    throw new Error(`unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  }
  _provider = new DimensionGuard(raw, config.EMBEDDING_DIMENSIONS);
  logger.info({ provider: _provider.name, model: _provider.modelId, dim: _provider.dimensions }, 'embeddings.ready');
  return _provider;
}

export function _resetForTests(): void {
  _provider = null;
}
