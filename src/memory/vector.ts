/**
 * Vector memory — `agent_memories` write + similarity recall facade.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #229, project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * The `agent_memories` table has `tenant_id` + `agent_id` columns (both
 * NOT NULL with a legacy `default` default — see `src/db/schema.ts`). Before
 * this fix both `writeMemory` and `recall` operated WITHOUT either predicate:
 *   - INSERT omitted both columns, so every vectorized memory landed in the
 *     shared `'default'` bucket regardless of which tenant produced it.
 *   - SELECT filtered ONLY by `escopo` (+ optional `tipo`), so a similarity
 *     recall could surface another tenant's memory as long as the embedding
 *     was close enough — a direct cross-tenant learning leak.
 *
 * AFTER this fix:
 *   1. `writeMemory` resolves `tenant_id` / `agent_id` from
 *      `getCurrentTenant()` / `getCurrentAgent()` BEFORE any work happens. If
 *      no tenant context is active the call throws `MissingTenantContextError`
 *      — a loud failure, never a silent fall-through to the `'default'`
 *      bucket. Rationale: a vectorized memory written without a tenant
 *      attribution would be unrecoverable cross-tenant pollution; better to
 *      surface the misuse than mask it.
 *   2. `recall` injects `tenant_id = <ctx> AND agent_id = <ctx>` into the
 *      WHERE clause, AFTER the `escopo` filter. Even if pgvector's similarity
 *      score would otherwise rank a foreign-tenant row higher, the predicate
 *      filters it out before the ORDER BY.
 *
 * Proven by `tests/unit/memory/vector-cross-tenant.spec.ts`: tenant-A INSERT
 * lands with `tenant_id='tenant-A'`, tenant-A `recall` never returns tenant-B
 * rows even when seeded adversarially (tenant-B rows inserted first AND with
 * an embedding closer to the query than tenant-A's).
 */
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { getEmbeddingProvider } from '@/lib/embeddings.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

export async function writeMemory(input: {
  conteudo: string;
  tipo: string;
  escopo: string;
  metadata?: Record<string, unknown>;
  ref_tabela?: string;
  ref_id?: string;
}): Promise<{ id: string }> {
  // Resolve tenant/agent BEFORE the embedding round-trip — if there is no
  // active tenant context this throws `MissingTenantContextError`. We refuse
  // to write a memory under the shared `'default'` bucket (see INVARIANT
  // block above).
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const provider = getEmbeddingProvider();
  const [embedding] = await provider.embed([input.conteudo]);
  if (!embedding) throw new Error('embedding_generation_failed');
  const vec = `[${embedding.join(',')}]`;
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO agent_memories (tenant_id, agent_id, conteudo, embedding, tipo, escopo, metadata, ref_tabela, ref_id)
    VALUES (${tenant_id}, ${agent_id}, ${input.conteudo}, ${vec}::vector, ${input.tipo}, ${input.escopo},
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
  // Resolve tenant/agent for the WHERE predicate. As with writeMemory, the
  // INVARIANT requires a routed context — a recall without one is a caller
  // bug and we let it surface (no silent fall-through to a cross-tenant
  // wildcard read).
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
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
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND escopo = ANY(${input.escopo}) ${tiposFilter}
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
