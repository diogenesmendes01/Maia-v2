import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { getEmbeddingProvider } from '@/lib/embeddings.js';
import { logger } from '@/lib/logger.js';

export async function writeMemory(input: {
  conteudo: string;
  tipo: string;
  escopo: string;
  metadata?: Record<string, unknown>;
  ref_tabela?: string;
  ref_id?: string;
}): Promise<{ id: string }> {
  const provider = getEmbeddingProvider();
  const [embedding] = await provider.embed([input.conteudo]);
  if (!embedding) throw new Error('embedding_generation_failed');
  const vec = `[${embedding.join(',')}]`;
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO agent_memories (conteudo, embedding, tipo, escopo, metadata, ref_tabela, ref_id)
    VALUES (${input.conteudo}, ${vec}::vector, ${input.tipo}, ${input.escopo},
            ${JSON.stringify(input.metadata ?? {})}::jsonb, ${input.ref_tabela ?? null},
            ${input.ref_id ?? null})
    RETURNING id::text
  `);
  return { id: (result.rows[0] as { id: string }).id };
}

export async function recall(input: {
  query: string;
  escopo: string[];
  tipos?: string[];
  k?: number;
}): Promise<Array<{ conteudo: string; tipo: string; escopo: string; score: number }>> {
  const provider = getEmbeddingProvider();
  const [emb] = await provider.embed([input.query]);
  if (!emb) return [];
  const vec = `[${emb.join(',')}]`;
  const limit = input.k ?? 5;
  const tiposFilter = input.tipos && input.tipos.length > 0 ? sql`AND tipo = ANY(${input.tipos})` : sql``;
  try {
    const result = await db.execute<{ conteudo: string; tipo: string; escopo: string; score: string }>(sql`
      SELECT conteudo, tipo, escopo, 1 - (embedding <=> ${vec}::vector) AS score
      FROM agent_memories
      WHERE escopo = ANY(${input.escopo}) ${tiposFilter}
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      conteudo: (r as { conteudo: string }).conteudo,
      tipo: (r as { tipo: string }).tipo,
      escopo: (r as { escopo: string }).escopo,
      score: Number((r as { score: string }).score),
    }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'memory.recall_failed');
    return [];
  }
}
