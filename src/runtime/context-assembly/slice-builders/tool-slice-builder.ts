/**
 * P8a — ToolPermissionSliceBuilder.
 *
 * Cross-references `decision.tool_permissions.allowed_tools` against the tool
 * registry to hydrate each allowed tool with its side_effect_level,
 * requires_confirmation, idempotent flag, audit_level, and timeout_ms.
 *
 * Blocked tools and requires_confirmation passthrough are carried straight
 * from the decision packet — they're authoritative.
 *
 * Spec §3.9 / Plan Task 11.
 */
import { createHash } from 'node:crypto';
import type {
  BaseContextPacket,
  ToolPermissionSlice,
} from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface ToolRequirements {
  /** Currently no shaping; future may toggle verbosity. */
  depth?: 'basic' | 'detailed';
}

export interface ToolDescriptor {
  name: string;
  side_effect_level: 'none' | 'low' | 'medium' | 'high';
  requires_confirmation: boolean;
  idempotent: boolean;
  audit_level: 'standard' | 'high';
  timeout_ms: number;
}

export interface ToolRegistryPort {
  getToolDescriptor(name: string): Promise<ToolDescriptor | null>;
}

export class ToolPermissionSliceBuilder
  implements SliceBuilder<ToolRequirements, ToolPermissionSlice>
{
  readonly name = 'tool' as const;

  constructor(
    private readonly registry: ToolRegistryPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, _req: ToolRequirements): string {
    // Cache is keyed by the set of allowed/blocked from the decision —
    // computed at build-time. See cacheScope inside build().
    return sliceCacheKey(base.tenant_id, 'tool', 'placeholder');
  }

  async build(
    input: SliceBuilderInput<ToolRequirements>,
  ): Promise<SliceBuilderResult<ToolPermissionSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    const allowed = input.decision.tool_permissions.allowed_tools;
    const blocked = input.decision.tool_permissions.blocked_tools;
    const requires_confirmation =
      input.decision.tool_permissions.requires_confirmation;

    const cacheScope = hashShort({
      allowed,
      blocked,
      requires_confirmation,
    });
    const key = sliceCacheKey(input.base.tenant_id, 'tool', cacheScope);

    const cached = await this.cache.get<ToolPermissionSlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    throwIfAborted(input.signal);

    // Hydrate every allowed tool. Tools not in the registry are silently
    // dropped (they cannot be safely called without metadata).
    const hydrated: ToolDescriptor[] = [];
    for (const name of allowed) {
      const desc = await this.registry.getToolDescriptor(name);
      if (desc) hydrated.push(desc);
    }

    const slice: ToolPermissionSlice = {
      available_tools: hydrated.map((t) => ({
        name: t.name,
        side_effect_level: t.side_effect_level,
        requires_confirmation: t.requires_confirmation,
        idempotent: t.idempotent,
        audit_level: t.audit_level,
        timeout_ms: t.timeout_ms,
      })),
      blocked_tools: [...blocked],
      requires_confirmation: [...requires_confirmation],
    };

    await this.cache.set(key, slice, getTTLForSlice('tool'));
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
