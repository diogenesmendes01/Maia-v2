/**
 * P8a — IdentitySliceBuilder.
 *
 * Reads `profile_body.identity` from the active operational profile version
 * (P4 schema: agent_operational_profile_versions). Falls back to an empty
 * IdentitySlice when no profile is active.
 *
 * Spec §3.3 / Plan Task 5.
 *
 * Depth semantics:
 *  - 'minimal' → role_descriptor, voice, cognitive_limits, schema_version, version_id
 *  - 'full'    → everything in 'minimal' + priorities + learned_voice_modifiers
 */
import { createHash } from 'node:crypto';
import type {
  BaseContextPacket,
  IdentitySlice,
} from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface IdentityRequirements {
  depth: 'minimal' | 'full';
}

/**
 * Repo port — what the builder needs from the operational profile repo.
 * The real implementation reads agent_operational_profile_versions where
 * status='active'. P4 ships the concrete repo; P8a only needs this shape.
 *
 * TODO(P4): replace with concrete operationalProfileVersionsRepo binding.
 */
export interface OperationalProfilePort {
  getActive(
    tenant_id: string,
    agent_id: string,
  ): Promise<OperationalProfileRecord | null>;
}

export interface OperationalProfileRecord {
  id: string;
  profile_body: {
    schema_version?: string;
    identity: {
      role_descriptor: string;
      voice: { tone: string; formality: string; verbosity: string };
      cognitive_limits: {
        max_inference_depth: number;
        max_speculation_in_response: number;
        confidence_floor_for_action: number;
      };
      priorities?: string[];
      learned_voice_modifiers?: Array<{
        aspect: string;
        modifier: string;
        strength: number;
      }>;
    };
  };
}

const EMPTY_IDENTITY: IdentitySlice = {
  role_descriptor: '',
  voice: { tone: '', formality: 'medium', verbosity: 'concise' },
  cognitive_limits: {
    max_inference_depth: 0,
    max_speculation_in_response: 0,
    confidence_floor_for_action: 0.5,
  },
  priorities: [],
  learned_voice_modifiers: [],
  schema_version: 'v3.1.1-2026-05-15',
  version_id: '',
};

export class IdentitySliceBuilder
  implements SliceBuilder<IdentityRequirements, IdentitySlice>
{
  readonly name = 'identity' as const;

  constructor(
    private readonly repo: OperationalProfilePort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: IdentityRequirements): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      depth: req.depth,
      schema_version: 'v3.1.1',
    });
    return sliceCacheKey(base.tenant_id, 'identity', scope);
  }

  async build(
    input: SliceBuilderInput<IdentityRequirements>,
  ): Promise<SliceBuilderResult<IdentitySlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);
    const key = this.cacheKey(input.base, input.requirements);

    // Cache lookup
    const cached = await this.cache.get<IdentitySlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    // Load active profile
    throwIfAborted(input.signal);
    const record = await this.repo.getActive(
      input.base.tenant_id,
      input.base.agent_id,
    );

    if (!record) {
      // No active profile — return empty slice. Cache briefly so we don't
      // hammer the DB.
      await this.cache.set(key, EMPTY_IDENTITY, 60);
      return {
        slice: EMPTY_IDENTITY,
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const body = record.profile_body;
    const slice: IdentitySlice = {
      role_descriptor: body.identity.role_descriptor,
      voice: body.identity.voice,
      cognitive_limits: body.identity.cognitive_limits,
      priorities:
        input.requirements.depth === 'full' ? (body.identity.priorities ?? []) : [],
      learned_voice_modifiers:
        input.requirements.depth === 'full'
          ? (body.identity.learned_voice_modifiers ?? [])
          : [],
      schema_version: body.schema_version ?? 'v3.1.1-2026-05-15',
      version_id: record.id,
    };

    await this.cache.set(key, slice, getTTLForSlice('identity'));
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
