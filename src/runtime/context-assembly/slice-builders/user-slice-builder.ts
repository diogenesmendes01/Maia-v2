/**
 * P8a — UserSliceBuilder (uses P8c facade stub).
 *
 * Reads pessoa attributes, memory entries (P2 + P8c), and behavioral hints.
 *
 * Spec §3.4 / Plan Task 6.
 *
 * Invariants (MEMORY.md — escopo por utilidade/sensibilidade):
 *  1. Memories only enter the slice when `proactive_use=true`. Sensitive
 *     memories with proactive_use=false NEVER leak into context — they only
 *     influence the agent via derived behavioral_hints.
 *  2. Truncation honours max_items from requirements.
 *  3. Depth 'none' returns an empty slice.
 *
 * TODO(P8c): replace stub port bindings with real user-layer facade.
 */
import { createHash } from 'node:crypto';
import type { BaseContextPacket, UserSlice } from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface UserRequirements {
  depth: 'none' | 'minimal' | 'relevant' | 'deep';
  max_items?: number;
  max_tokens_hint?: number;
}

export interface PessoaRecord {
  id: string;
  display_name: string | null;
  locale: string;
  preferences?: Record<string, unknown>;
}

export interface MemoryEntryRecord {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  scope: string;
  sensitivity: string;
  proactive_use: boolean;
}

export interface BehavioralHintRecord {
  aspect: string;
  suggestion: string;
  strength: number;
}

/**
 * Port covering pessoa + memory + hints lookup. Real impl backed by the P2
 * memory_entry repo and the future P8c user-layer namespace.
 */
export interface UserLayerPort {
  getPessoa(
    tenant_id: string,
    pessoa_id: string | null,
  ): Promise<PessoaRecord | null>;
  listMemories(
    tenant_id: string,
    pessoa_id: string | null,
    opts: { depth: UserRequirements['depth']; max_items: number },
  ): Promise<MemoryEntryRecord[]>;
  listBehavioralHints(
    tenant_id: string,
    pessoa_id: string | null,
  ): Promise<BehavioralHintRecord[]>;
}

const EMPTY_USER: UserSlice = {
  pessoa: null,
  preferences: {},
  memories: [],
  behavioral_hints: [],
  truncated: false,
};

export class UserSliceBuilder
  implements SliceBuilder<UserRequirements, UserSlice>
{
  readonly name = 'user' as const;

  constructor(
    private readonly port: UserLayerPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: UserRequirements): string {
    const scope = hashShort({
      pessoa_id: base.actor.pessoa_id,
      depth: req.depth,
      max_items: req.max_items ?? 5,
    });
    return sliceCacheKey(base.tenant_id, 'user', scope);
  }

  async build(
    input: SliceBuilderInput<UserRequirements>,
  ): Promise<SliceBuilderResult<UserSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);
    const key = this.cacheKey(input.base, input.requirements);

    if (input.requirements.depth === 'none') {
      return {
        slice: EMPTY_USER,
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const cached = await this.cache.get<UserSlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    const maxItems = input.requirements.max_items ?? 5;
    throwIfAborted(input.signal);

    const [pessoa, allMemories, hints] = await Promise.all([
      this.port.getPessoa(input.base.tenant_id, input.base.actor.pessoa_id),
      this.port.listMemories(input.base.tenant_id, input.base.actor.pessoa_id, {
        depth: input.requirements.depth,
        // Ask for max_items+1 so we can detect truncation reliably.
        max_items: maxItems + 1,
      }),
      this.port.listBehavioralHints(
        input.base.tenant_id,
        input.base.actor.pessoa_id,
      ),
    ]);

    // Filter: only proactive_use=true memories enter the slice.
    const filtered = allMemories.filter((m) => m.proactive_use);

    const truncated = filtered.length > maxItems;
    const memories = truncated ? filtered.slice(0, maxItems) : filtered;

    const slice: UserSlice = {
      pessoa: pessoa
        ? {
            id: pessoa.id,
            display_name: pessoa.display_name,
            locale: pessoa.locale,
          }
        : null,
      preferences: pessoa?.preferences ?? {},
      memories: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        content: m.content,
        confidence: m.confidence,
        scope: m.scope,
        sensitivity: m.sensitivity,
        proactive_use: m.proactive_use,
      })),
      behavioral_hints: hints.map((h) => ({
        aspect: h.aspect,
        suggestion: h.suggestion,
        strength: h.strength,
      })),
      truncated,
    };

    await this.cache.set(key, slice, getTTLForSlice('user'));
    return {
      slice,
      cache_hit: false,
      duration_ms: performance.now() - start,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function hashShort(obj: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 12);
}
