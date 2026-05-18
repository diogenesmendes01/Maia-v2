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

/**
 * Unambiguous structured key. agent_id stays null (not a sentinel string)
 * so a real agent with id 'wide' cannot collide with tenant-wide entries.
 *
 * Format: JSON.stringify([tenant_id, agent_id, descriptor, canonScope])
 * — JSON preserves null vs string distinction; canonScope is already a
 * deterministic string so the outer JSON never embeds nested JSON.
 */
export function cacheKeyHash(k: CacheKey): string {
  return JSON.stringify([k.tenant_id, k.agent_id, k.descriptor, canonScope(k.scope)]);
}

/** Key prefix used by invalidate() to match entries to drop. */
function invalidationPrefix(
  tenant_id: string,
  agent_id: string | null,
  descriptor: string,
): string {
  // The full key is JSON.stringify([tenant_id, agent_id, descriptor, scope]).
  // We cannot use a simple string prefix here because JSON encodes strings
  // with quotes and null as null. Instead callers compare full-parsed segments.
  // This helper is kept for the agent-specific invalidate branch which
  // still needs a way to efficiently scan. We return the partial prefix that
  // matches the first three components; callers must verify the parse.
  //
  // Note: the tenant-wide (agent_id=null) invalidation branch in invalidate()
  // does NOT use this helper — it iterates and parses each key.
  return JSON.stringify([tenant_id, agent_id, descriptor]).slice(0, -1); // strips trailing ']'
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
    // Codex review #93 finding: when agent_id is null (tenant-wide
    // lifecycle event), we MUST also evict any agent-specific cache entries
    // for the same (tenant, descriptor). The resolver caches under the
    // requested agent_id even when the underlying row is the tenant-wide
    // fallback, so a tenant-wide deprecate/activate must fan-out across
    // all cached agent_ids. Otherwise an agent that previously hit
    // `agent_id=A | descriptor=D | scope=...` would keep serving the
    // stale resolved policy (or stale `unresolved` miss) for up to ttl_ms.
    //
    // Key format (post round-2 fix): JSON.stringify([tenant_id, agent_id, descriptor, scope_str])
    // We parse each key and compare slots exactly — no sentinel strings, no substring tricks.
    if (args.agent_id === null) {
      // Fan-out: evict all entries for this (tenant, descriptor) regardless of agent_id.
      for (const [k, e] of this.store) {
        let parsed: unknown;
        try { parsed = JSON.parse(k); } catch { continue; }
        if (!Array.isArray(parsed) || parsed.length < 3) continue;
        // slots: [tenant_id, agent_id, descriptor, scope_str]
        if (parsed[0] === args.tenant_id && parsed[2] === args.descriptor) {
          this.removeFromList(k, e);
          this.store.delete(k);
        }
      }
      return;
    }
    // Agent-specific event: invalidate only entries for that exact agent.
    // Use the structured prefix (first 3 slots) to match without parsing scope.
    const prefix = invalidationPrefix(args.tenant_id, args.agent_id, args.descriptor);
    for (const [k, e] of this.store) {
      if (k.startsWith(prefix)) {
        // Verify the prefix is not a false positive by parsing.
        let parsed: unknown;
        try { parsed = JSON.parse(k); } catch { continue; }
        if (!Array.isArray(parsed) || parsed.length < 3) continue;
        if (parsed[0] === args.tenant_id && parsed[1] === args.agent_id && parsed[2] === args.descriptor) {
          this.removeFromList(k, e);
          this.store.delete(k);
        }
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
 * Pure handler: parses a Redis pub/sub message and invalidates the given
 * cache. Extracted from startPolicyCacheInvalidationSubscriber() so tests
 * can verify the wiring without standing up a Redis client.
 *
 * Codex review #93: previously the handler logic was inline in the
 * subscriber start function and untestable in isolation; the only proof
 * that "Redis publish invalidates cache" was the publish branch, never
 * the subscribe branch. This indirection lets a unit test exercise the
 * full publish-payload → cache-invalidate path.
 */
export function handlePolicyLifecycleMessage(
  channel: string,
  msg: string,
  cache: PolicyResolverCache = policyResolverCache,
): void {
  if (channel !== POLICY_LIFECYCLE_CHANNEL) return;
  try {
    const evt = JSON.parse(msg) as PolicyLifecycleEvent;
    cache.invalidate({
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
}

/**
 * Idempotent: starts the Redis subscriber the first time it's called,
 * then no-ops. Failure to subscribe is logged but doesn't throw —
 * caches still expire naturally via TTL.
 *
 * Wired from src/index.ts startup when FEATURE_POLICY_RESOLVER_V1 is on.
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
  void sub.subscribe(POLICY_LIFECYCLE_CHANNEL, (err) => {
    if (err) {
      logger.warn(
        { err: err.message },
        'policy_cache.subscribe_failed_natural_ttl_only',
      );
    }
  });
  sub.on('message', (channel, msg) => {
    handlePolicyLifecycleMessage(channel, msg);
  });
}

/**
 * Test-only: reset the once-flag so the integration test can re-invoke
 * `startPolicyCacheInvalidationSubscriber` after the spec replaces the
 * Redis client. Production code must NOT call this.
 */
export function _resetPolicyCacheSubscriberStartedFlag(): void {
  subscriberStarted = false;
}
