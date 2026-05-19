/**
 * P8a — SoulSliceBuilder (Soul biases — uses P8b stub).
 *
 * Reads soul_biases (P8b table). Orders by strength DESC. Soul inclines but
 * never blocks — this is enforced by the orchestrator's design: SoulSlice has
 * no `forbidden_actions` field.
 *
 * Spec §3.6 / Plan Task 8.
 *
 * TODO(P8b): replace stub binding with real Soul layer producer.
 */
import { createHash } from 'node:crypto';
import type { BaseContextPacket, SoulSlice } from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface SoulRequirements {
  depth: 'none' | 'relevant';
  max_biases?: number;
}

export interface SoulBiasRecord {
  id: string;
  principle: string;
  strength: number;
  origin: string;
  scope: string;
  scope_value: string | null;
  version_id: string;
}

export interface SoulPort {
  listActiveBiases(
    tenant_id: string,
    agent_id: string,
    opts: { limit: number },
  ): Promise<SoulBiasRecord[]>;
}

/**
 * Stub Soul port returning no biases. Replaced when P8b lands.
 * TODO(P8b): replace with real soul layer port.
 */
export const stubSoulPort: SoulPort = {
  async listActiveBiases() {
    return [];
  },
};

export class SoulSliceBuilder
  implements SliceBuilder<SoulRequirements, SoulSlice>
{
  readonly name = 'soul' as const;

  constructor(
    private readonly port: SoulPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: SoulRequirements): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      depth: req.depth,
      max_biases: req.max_biases ?? 5,
    });
    return sliceCacheKey(base.tenant_id, 'soul', scope);
  }

  async build(
    input: SliceBuilderInput<SoulRequirements>,
  ): Promise<SliceBuilderResult<SoulSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    if (input.requirements.depth === 'none') {
      return {
        slice: { biases: [], truncated: false },
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const key = this.cacheKey(input.base, input.requirements);
    const cached = await this.cache.get<SoulSlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    const max = input.requirements.max_biases ?? 5;
    throwIfAborted(input.signal);
    const rows = await this.port.listActiveBiases(
      input.base.tenant_id,
      input.base.agent_id,
      { limit: max * 2 + 1 },
    );

    // Sort by strength DESC (ties keep input order — stable sort in V8).
    const sorted = [...rows].sort((a, b) => b.strength - a.strength);
    const truncated = sorted.length > max;
    const biases = truncated ? sorted.slice(0, max) : sorted;

    const slice: SoulSlice = {
      biases: biases.map((b) => ({
        id: b.id,
        principle: b.principle,
        strength: b.strength,
        origin: b.origin,
        scope: b.scope,
        scope_value: b.scope_value,
        version_id: b.version_id,
      })),
      truncated,
    };

    await this.cache.set(key, slice, getTTLForSlice('soul'));
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

/**
 * Convenience stub for callers that want the empty-Soul shape directly
 * without a builder. Used in P8a integration tests; replaced when P8b ships.
 *
 * TODO(P8b): replace stub when P8b lands.
 */
export function buildSoulSlice(): SoulSlice {
  return { biases: [], truncated: false };
}
