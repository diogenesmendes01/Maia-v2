import { performance } from 'perf_hooks';
import { memoryResolver } from './resolvers/memory-resolver.js';
import { hintsResolver } from './resolvers/hints-resolver.js';
import { interlocutorResolver } from './resolvers/interlocutor-resolver.js';
import { getUserMaxItems } from './internal/depth-mapping.js';
import { buildUserSliceCacheKey } from './internal/cache-keys.js';
import type { UserSlice, UserDepth } from './types.js';

export interface BuildUserSliceOutput {
  slice: UserSlice;
  latency_ms: number;
  cache_key: string;
}

export async function buildUserSlice(input: {
  tenant_id: string;
  pessoa_id: string;
  depth: UserDepth;
  max_items?: number;
  intent_label?: string;
  scope_hint?: string[];
  trace_id: string;
}): Promise<BuildUserSliceOutput> {
  const start = performance.now();
  const max_items = input.max_items ?? getUserMaxItems(input.depth);
  const cache_key = buildUserSliceCacheKey({
    tenant_id: input.tenant_id,
    pessoa_id: input.pessoa_id,
    depth: input.depth,
    intent_label: input.intent_label,
    scope_hint: input.scope_hint,
  });

  try {
    // Load interlocutor (always)
    const interlocutor = await interlocutorResolver.get({
      tenant_id: input.tenant_id,
      pessoa_id: input.pessoa_id,
    });

    // Load memories & hints based on depth
    let memories: any[] = [];
    let behavioral_hints: any[] = [];

    if (input.depth !== 'none') {
      memories = await memoryResolver.list({
        tenant_id: input.tenant_id,
        pessoa_id: input.pessoa_id,
        limit: max_items,
        intent_filter: input.intent_label,
      });
    }

    if (input.depth === 'relevant' || input.depth === 'deep') {
      behavioral_hints = await hintsResolver.list({
        tenant_id: input.tenant_id,
        pessoa_id: input.pessoa_id,
        limit: input.depth === 'deep' ? 999 : 5,
      });
    }

    const slice: UserSlice = {
      depth: input.depth,
      interlocutor: {
        pessoa_id: interlocutor.pessoa_id,
        nome_preferido: interlocutor.nome,
        apelido: interlocutor.apelido ?? undefined,
        tipo: interlocutor.tipo,
        status: interlocutor.status,
      },
      profile: {
        preferencias: interlocutor.preferencias ?? {},
        modelo_mental: interlocutor.modelo_mental ?? {},
      },
      memories,
      behavioral_hints,
      meta: {
        cache_hit: false, // P8b cache layer will set this
        truncated: memories.length >= max_items,
        items_total: memories.length,
        items_returned: memories.length,
      },
    };

    return {
      slice,
      latency_ms: performance.now() - start,
      cache_key,
    };
  } catch (error) {
    throw new Error(`Failed to build UserSlice: ${error}`, { cause: error });
  }
}
