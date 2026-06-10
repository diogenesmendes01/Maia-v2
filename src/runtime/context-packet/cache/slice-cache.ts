/**
 * P8a — SliceCache: Redis-backed cache for assembled slices.
 *
 * Spec §4 — get/set/invalidate primitives with TTL jitter and pattern-based
 * invalidation. Keys follow `maia:context:v2:{tenant}:{agent}:{slice}:{scope_hash}`.
 *
 * Issue #235 (LOW, latent): keys MUST be scoped by `agent_id` in addition to
 * `tenant_id`. Several slice builders (knowledge, policy, user) had scope
 * hashes that did NOT encode `agent_id`, allowing silent cross-agent cache
 * collisions inside a single tenant if a real Redis backend were wired.
 * Version bumped v1 → v2 to invalidate any pre-existing entries written
 * before agent_id was in the key.
 *
 * In-memory implementation provided for tests and as default fallback when
 * Redis isn't wired. Redis implementation imports ioredis from src/lib/redis.
 */

import { jitteredTTL } from './ttl-policy.js';
import { assertValidScope } from '../../../user-layer/internal/cache-keys.js';
import { buildCacheKey } from '../../../lib/cache-key.js';

export interface SliceCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  invalidate(keyPattern: string): Promise<number>;
  invalidateSliceForTenant(tenant_id: string, slice: string): Promise<number>;
}

/**
 * Key builder — `maia:context:v2:{tenant_id}:{agent_id}:{slice}:{scope_hash}`.
 *
 * Issue #235: `agent_id` MUST be in the key prefix (not only the scope hash
 * sometimes provided by callers) so the invalidation glob patterns produced
 * by `invalidateSliceForTenant` continue to work, and so two agents on the
 * same tenant cannot collide on a cached slice even when individual builders
 * forget to include agent_id in their scope hash.
 *
 * Issue #235 (Codex reval, HIGH): fails closed via `assertValidScope` when
 * `tenant_id` or `agent_id` is empty / non-string. Silently interpolating an
 * empty agent_id would produce a key like `maia:context:v2:tenant::slice:hash`
 * — a tenant-wide degenerate scope that re-introduces the cross-agent leak the
 * v1→v2 bump was meant to close. Throw instead.
 *
 * Issue #287: segments are routed through the centralized `buildCacheKey`
 * so a `:` inside a free-form id can no longer alias across slots, and glob
 * metacharacters are neutralized — which keeps the `invalidate()` MATCH
 * patterns below literal-safe. Key-compatibility: production tenant/agent
 * slugs (`[a-z0-9][a-z0-9_-]*`), slice names (closed code set), and hex
 * scope hashes all encode to themselves, so every realizable key is
 * byte-identical to the previous raw interpolation — the `v2` version tag
 * is unchanged, no bump needed.
 */
export function sliceCacheKey(
  tenant_id: string,
  agent_id: string,
  slice: string,
  scope_hash: string,
): string {
  assertValidScope(tenant_id, agent_id);
  return buildCacheKey('maia:context:v2:', tenant_id, agent_id, slice, scope_hash);
}

// ============================================================================
// InMemorySliceCache — default for tests, fallback when Redis unavailable
// ============================================================================

interface Entry {
  value: string;
  expires_at_ms: number;
}

export class InMemorySliceCache implements SliceCache {
  private store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires_at_ms <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const ttl = jitteredTTL(ttlSeconds);
    this.store.set(key, {
      value: JSON.stringify(value),
      expires_at_ms: Date.now() + ttl * 1000,
    });
  }

  async invalidate(keyPattern: string): Promise<number> {
    const regex = patternToRegex(keyPattern);
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (regex.test(key)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  async invalidateSliceForTenant(
    tenant_id: string,
    slice: string,
  ): Promise<number> {
    // Issue #235: key format is `maia:context:v2:{tenant}:{agent}:{slice}:*`.
    // Wildcard the agent_id position so an event scoped to a tenant
    // invalidates all agents' slices under that tenant. A future
    // `invalidateSliceForAgent(tenant_id, agent_id, slice)` can narrow the
    // wildcard when invalidation events carry agent_id.
    return this.invalidate(invalidationPatternForTenant(tenant_id, slice));
  }

  /** Test helper: total entries currently in cache (alive or expired). */
  size(): number {
    return this.store.size;
  }

  /** Test helper: clear everything. */
  clear(): void {
    this.store.clear();
  }
}

// ============================================================================
// RedisSliceCache — production cache backed by ioredis
// ============================================================================

interface RedisLike {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  keys(pattern: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
}

export class RedisSliceCache implements SliceCache {
  constructor(private readonly redis: RedisLike) {}

  async get<T>(key: string): Promise<T | null> {
    const val = await this.redis.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const jittered = jitteredTTL(ttlSeconds);
    await this.redis.setex(key, jittered, JSON.stringify(value));
  }

  async invalidate(keyPattern: string): Promise<number> {
    const keys = await this.redis.keys(keyPattern);
    if (keys.length === 0) return 0;
    return await this.redis.del(...keys);
  }

  async invalidateSliceForTenant(
    tenant_id: string,
    slice: string,
  ): Promise<number> {
    // Issue #235: key format is `maia:context:v2:{tenant}:{agent}:{slice}:*`.
    // Wildcard the agent_id position; see InMemorySliceCache comment.
    return this.invalidate(invalidationPatternForTenant(tenant_id, slice));
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the tenant-wide invalidation MATCH pattern. The `tenant_id` and
 * `slice` segments are encoded with the SAME `buildCacheKey` encoder used by
 * `sliceCacheKey` so the pattern matches written keys byte-for-byte (#287) —
 * and so a tenant slug containing `:` or a glob metachar can neither bleed
 * into a neighbouring slot nor widen the wildcard (e.g. `tenant="acme"` must
 * NOT clear `tenant="acme:dev"` entries and vice-versa). The `*` wildcards
 * for the agent and scope-hash positions are appended raw on purpose.
 */
function invalidationPatternForTenant(tenant_id: string, slice: string): string {
  const tenantSeg = buildCacheKey('', tenant_id);
  const sliceSeg = buildCacheKey('', slice);
  return `maia:context:v2:${tenantSeg}:*:${sliceSeg}:*`;
}

function patternToRegex(pattern: string): RegExp {
  // Convert redis-style glob (`*`, `?`) to JS regex. Escape every other
  // metacharacter conservatively.
  const escaped = pattern.replace(/[\\^$.+(){}[\]|]/g, '\\$&');
  const regexBody = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexBody}$`);
}
