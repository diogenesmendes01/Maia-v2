/**
 * P8e — PolicyResolverCache: in-memory TTL + LRU + Redis-pubsub invalidation.
 *
 * Master spec v3.1.1 §3.3 (TTL 5-10min) and §6 (cache implementation).
 *
 * Design:
 *   - In-process Map<string, Entry> keyed by `tenant|agent|descriptor|scope`
 *   - TTL (default 5min) via stored `expireAt` per entry
 *   - LRU eviction when size > max_entries (default 10_000)
 *   - Negative caching: `'unresolved'` stored to avoid repeated DB misses
 *   - Redis pub/sub subscription on POLICY_LIFECYCLE_CHANNEL invalidates
 *     entries matching {tenant_id, agent_id, descriptor}
 *
 * Failure mode: if Redis is down, TTL natural expiry bounds staleness to
 * `ttl_ms`. Strict read-after-write for hard_limit policies lives in P9d.
 */
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import type {
  PolicyRuleScope,
  ResolvedPolicy,
  PolicyLifecycleEvent,
} from './types.js';
import { POLICY_LIFECYCLE_CHANNEL } from './policy-rules-repo.js';

export interface CacheKey {
  tenant_id: string;
  agent_id: string | null;
  descriptor: string;
  scope: PolicyRuleScope;
}

export type CacheValue = ResolvedPolicy | 'unresolved';

interface CacheEntry {
  value: CacheValue;
  expireAt: number;
  // doubly-linked list pointers (LRU). Stored on entry object for O(1)
  // pop on access; we keep tail = most recent.
  prev: string | null;
  next: string | null;
}

interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  evictions: number;
}

export interface PolicyResolverCache {
  get(key: CacheKey): CacheValue | undefined;
  set(key: CacheKey, value: ResolvedPolicy): void;
  setUnresolved(key: CacheKey): void;
  invalidate(args: { tenant_id: string; agent_id: string | null; descriptor: string }): void;
  invalidateAll(): void;
  stats(): CacheStats;
}

/**
 * Canonicalize scope so equal-content scopes hash to identical strings.
 * Drops undefined values, sorts keys alphabetically.
 */
function canonScope(scope: PolicyRuleScope | undefined): string {
  if (!scope) return '{}';
  const entries = Object.entries(scope)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '{}';
  // JSON.stringify on sorted entries gives deterministic output without
  // relying on Object insertion order.
  return JSON.stringify(entries);
}

export function cacheKeyHash(k: CacheKey): string {
  return `${k.tenant_id}|${k.agent_id ?? 'wide'}|${k.descriptor}|${canonScope(k.scope)}`;
}

/** Key prefix used by invalidate() to match entries to drop. */
function invalidationPrefix(
  tenant_id: string,
  agent_id: string | null,
  descriptor: string,
): string {
  return `${tenant_id}|${agent_id ?? 'wide'}|${descriptor}|`;
}

export interface PolicyCacheConfig {
  ttl_ms: number;
  max_entries: number;
}

export class PolicyResolverCacheImpl implements PolicyResolverCache {
  private readonly store = new Map<string, CacheEntry>();
  private head: string | null = null; // least-recent
  private tail: string | null = null; // most-recent
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly cfg: PolicyCacheConfig) {}

  get(key: CacheKey): CacheValue | undefined {
    const h = cacheKeyHash(key);
    const entry = this.store.get(h);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expireAt < Date.now()) {
      // Expired — treat as miss; reap from store.
      this.removeFromList(h, entry);
      this.store.delete(h);
      this.misses++;
      return undefined;
    }
    // Hit — promote to tail (most recently used).
    this.moveToTail(h, entry);
    this.hits++;
    return entry.value;
  }

  set(key: CacheKey, value: ResolvedPolicy): void {
    this.put(cacheKeyHash(key), value);
  }

  setUnresolved(key: CacheKey): void {
    this.put(cacheKeyHash(key), 'unresolved');
  }

  invalidate(args: {
    tenant_id: string;
    agent_id: string | null;
    descriptor: string;
  }): void {
    const prefix = invalidationPrefix(args.tenant_id, args.agent_id, args.descriptor);
    for (const [k, e] of this.store) {
      if (k.startsWith(prefix)) {
        this.removeFromList(k, e);
        this.store.delete(k);
      }
    }
  }

  invalidateAll(): void {
    this.store.clear();
    this.head = null;
    this.tail = null;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.store.size,
      evictions: this.evictions,
    };
  }

  // --- private LRU helpers ---

  private put(hash: string, value: CacheValue): void {
    const existing = this.store.get(hash);
    if (existing) {
      existing.value = value;
      existing.expireAt = Date.now() + this.cfg.ttl_ms;
      this.moveToTail(hash, existing);
      return;
    }
    const entry: CacheEntry = {
      value,
      expireAt: Date.now() + this.cfg.ttl_ms,
      prev: this.tail,
      next: null,
    };
    if (this.tail) {
      const tailEntry = this.store.get(this.tail);
      if (tailEntry) tailEntry.next = hash;
    }
    this.tail = hash;
    if (!this.head) this.head = hash;
    this.store.set(hash, entry);
    // Evict from head if oversize.
    while (this.store.size > this.cfg.max_entries && this.head) {
      const oldest = this.head;
      const e = this.store.get(oldest);
      if (!e) break;
      this.removeFromList(oldest, e);
      this.store.delete(oldest);
      this.evictions++;
    }
  }

  private moveToTail(hash: string, entry: CacheEntry): void {
    if (this.tail === hash) return;
    this.removeFromList(hash, entry);
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail) {
      const tailEntry = this.store.get(this.tail);
      if (tailEntry) tailEntry.next = hash;
    }
    this.tail = hash;
    if (!this.head) this.head = hash;
  }

  private removeFromList(hash: string, entry: CacheEntry): void {
    if (entry.prev) {
      const prevEntry = this.store.get(entry.prev);
      if (prevEntry) prevEntry.next = entry.next;
    } else if (this.head === hash) {
      this.head = entry.next;
    }
    if (entry.next) {
      const nextEntry = this.store.get(entry.next);
      if (nextEntry) nextEntry.prev = entry.prev;
    } else if (this.tail === hash) {
      this.tail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
  }
}

/**
 * Singleton: in-process cache + Redis subscriber for cross-instance
 * invalidation. We use a dedicated subscriber (ioredis requires this:
 * once a client SUBSCRIBE'd, it cannot send other commands).
 *
 * Tests should construct a fresh PolicyResolverCacheImpl directly
 * (no Redis) to avoid sharing state across specs.
 */
export const policyResolverCache: PolicyResolverCache = new PolicyResolverCacheImpl({
  ttl_ms: config.POLICY_RESOLVER_CACHE_TTL_MS,
  max_entries: config.POLICY_RESOLVER_CACHE_MAX_ENTRIES,
});

let subscriberStarted = false;

/**
 * Idempotent: starts the Redis subscriber the first time it's called,
 * then no-ops. Failure to subscribe is logged but doesn't throw —
 * caches still expire naturally via TTL.
 */
export function startPolicyCacheInvalidationSubscriber(): void {
  if (subscriberStarted) return;
  subscriberStarted = true;
  const sub = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  sub.on('error', (err) => {
    logger.warn({ err: err.message }, 'policy_cache.subscriber_error');
  });
  sub.connect().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'policy_cache.subscribe_connect_failed');
  });
  sub.subscribe(POLICY_LIFECYCLE_CHANNEL, (err) => {
    if (err) {
      logger.warn(
        { err: err.message },
        'policy_cache.subscribe_failed_natural_ttl_only',
      );
    }
  });
  sub.on('message', (channel, msg) => {
    if (channel !== POLICY_LIFECYCLE_CHANNEL) return;
    try {
      const evt = JSON.parse(msg) as PolicyLifecycleEvent;
      policyResolverCache.invalidate({
        tenant_id: evt.tenant_id,
        agent_id: evt.agent_id,
        descriptor: evt.descriptor,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, msg },
        'policy_cache.invalid_event_payload',
      );
    }
  });
}
