import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export interface EmbeddingProvider {
  name: 'voyage' | 'openai' | 'cohere';
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
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

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;
  if (config.EMBEDDING_PROVIDER === 'voyage') {
    if (!config.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY missing');
    _provider = new VoyageProvider(config.VOYAGE_API_KEY, config.EMBEDDING_MODEL, config.EMBEDDING_DIMENSIONS);
  } else if (config.EMBEDDING_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    _provider = new OpenAIEmbeddingProvider(config.OPENAI_API_KEY, config.EMBEDDING_MODEL, config.EMBEDDING_DIMENSIONS);
  } else if (config.EMBEDDING_PROVIDER === 'cohere') {
    if (!config.COHERE_API_KEY) throw new Error('COHERE_API_KEY missing');
    _provider = new CohereEmbeddingProvider(
      config.COHERE_API_KEY,
      config.EMBEDDING_MODEL,
      config.EMBEDDING_DIMENSIONS,
    );
  } else {
    throw new Error(`unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  }
  if (_provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding provider dim ${_provider.dimensions} != config ${config.EMBEDDING_DIMENSIONS}`,
    );
  }
  logger.info({ provider: _provider.name, dim: _provider.dimensions }, 'embeddings.ready');
  return _provider;
}
