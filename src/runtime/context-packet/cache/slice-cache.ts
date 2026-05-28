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
 */
export function sliceCacheKey(
  tenant_id: string,
  agent_id: string,
  slice: string,
  scope_hash: string,
): string {
  return `maia:context:v2:${tenant_id}:${agent_id}:${slice}:${scope_hash}`;
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
    return this.invalidate(`maia:context:v2:${tenant_id}:*:${slice}:*`);
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
    return this.invalidate(`maia:context:v2:${tenant_id}:*:${slice}:*`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function patternToRegex(pattern: string): RegExp {
  // Convert redis-style glob (`*`, `?`) to JS regex. Escape every other
  // metacharacter conservatively.
  const escaped = pattern.replace(/[\\^$.+(){}[\]|]/g, '\\$&');
  const regexBody = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexBody}$`);
}
