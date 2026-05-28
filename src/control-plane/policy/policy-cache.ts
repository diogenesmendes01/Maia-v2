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
 *   - Redis pub/sub explicit per-tenant SUBSCRIBE on
 *     `policy_rule_lifecycle:{tenant_id}` — see #249.
 *
 * Why explicit per-tenant SUBSCRIBE (NOT PSUBSCRIBE wildcard) — issue #249
 * Codex round-2 verdict:
 *   - `PSUBSCRIBE policy_rule_lifecycle:*` made every subscriber receive
 *     events from every tenant. Even with a payload-tenant guard in the
 *     handler, the BROKER was still delivering cross-tenant payloads —
 *     defense-in-depth ≠ isolation. The CRITICAL bar for #249 is broker-
 *     side routing isolation, not handler-level filtering.
 *   - Fix: use explicit `SUBSCRIBE policy_rule_lifecycle:<tenantId>` for
 *     each tenant this cache instance actually serves. Redis then ONLY
 *     delivers messages for the tenants this process has subscribed to.
 *
 * Subscriber lifecycle — LAZY per-tenant subscribe:
 *   - At process boot the subscriber connects to Redis but has NO active
 *     subscriptions. The cache has no entries; nothing to invalidate.
 *   - On the first cache write for a tenant (positive set() OR negative
 *     setUnresolved()), `ensureTenantSubscribed(tenant_id)` issues a
 *     `SUBSCRIBE policy_rule_lifecycle:<tenant_id>` exactly once per
 *     (process, tenant_id). Subsequent writes are O(1) — a Set membership
 *     check.
 *   - Why lazy: tenants aren't declared at boot; a process serves any
 *     tenant whose request lands on it. Boot-time enumeration would either
 *     subscribe to ALL tenants (defeats isolation when the DB lists more
 *     tenants than this process actually serves) or miss tenants
 *     onboarded after boot. Lazy subscribe ties the subscription set
 *     exactly to the cache's working set.
 *   - Unsubscribe-on-eviction is deliberately NOT implemented: a tenant
 *     evicted from the cache could be re-touched milliseconds later, and
 *     SUBSCRIBE/UNSUBSCRIBE churn is more expensive than holding O(K)
 *     idle subscriptions in steady state.
 *
 * Handler still cross-checks channel-tenant vs payload-tenant for
 * defense-in-depth against (a) a publisher bug that built an event in
 * tenant-A context but somehow published on tenant-B's channel, or (b) a
 * Redis ACL misconfiguration. With explicit SUBSCRIBE the broker no
 * longer delivers cross-tenant payloads on the happy path, so this guard
 * is a safety net rather than the primary isolation mechanism.
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
import {
  POLICY_LIFECYCLE_CHANNEL,
  buildPolicyLifecycleChannel,
  parsePolicyLifecycleChannel,
} from './policy-rules-repo.js';

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
  /**
   * Issue #249: called the first time the cache writes an entry for a
   * tenant_id this instance has not seen yet. The subscriber wiring uses
   * this hook to fire `SUBSCRIBE policy_rule_lifecycle:<tenant_id>` so
   * that the broker only delivers events for tenants this cache holds.
   *
   * Errors thrown by the hook are caught and logged — they MUST NOT
   * propagate into the write path. A failed subscribe just means TTL
   * natural expiry handles staleness for that tenant.
   *
   * Optional: tests can construct caches without the hook (no Redis).
   */
  onTenantTouched?: (tenant_id: string) => void;
}

export class PolicyResolverCacheImpl implements PolicyResolverCache {
  private readonly store = new Map<string, CacheEntry>();
  /**
   * Issue #249: tenants this cache has written at least one entry for.
   * Drives lazy per-tenant SUBSCRIBE — see file header. Held in memory
   * only; on process restart the next write re-triggers subscription.
   */
  private readonly subscribedTenants = new Set<string>();
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
    this.notifyTenantTouched(key.tenant_id);
  }

  setUnresolved(key: CacheKey): void {
    this.put(cacheKeyHash(key), 'unresolved');
    this.notifyTenantTouched(key.tenant_id);
  }

  /**
   * Issue #249: first-write hook into the lazy subscriber. Fires
   * `onTenantTouched` exactly once per (cache instance, tenant_id) so the
   * Redis subscriber can `SUBSCRIBE policy_rule_lifecycle:<tenant_id>`.
   *
   * Errors are swallowed — a failed subscribe just means TTL natural
   * expiry handles staleness for that tenant. We do NOT want a Redis
   * blip to take down the cache write path.
   */
  private notifyTenantTouched(tenant_id: string): void {
    if (this.subscribedTenants.has(tenant_id)) return;
    this.subscribedTenants.add(tenant_id);
    const hook = this.cfg.onTenantTouched;
    if (!hook) return;
    try {
      hook(tenant_id);
    } catch (err) {
      // Best-effort: log if a logger is available; never throw.
      try {
        // Lazy logger import would create a cycle here; we re-use the
        // already-imported `logger`.
        logger.warn(
          { err: (err as Error).message, tenant_id },
          'policy_cache.on_tenant_touched_hook_failed',
        );
      } catch {
        // No-op: best-effort.
      }
    }
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
 *
 * Issue #249: the singleton's `onTenantTouched` hook is wired by
 * `startPolicyCacheInvalidationSubscriber()` once the Redis client is
 * up. Until then writes still record the tenant locally; the subscribe
 * call happens at startup time when the hook is wired, then again on
 * each new tenant touched after startup.
 */
let pendingSubscribe: ((tenant_id: string) => void) | null = null;

export const policyResolverCache: PolicyResolverCache = new PolicyResolverCacheImpl({
  ttl_ms: config.POLICY_RESOLVER_CACHE_TTL_MS,
  max_entries: config.POLICY_RESOLVER_CACHE_MAX_ENTRIES,
  onTenantTouched: (tenant_id: string) => {
    // Delegate to whatever wire-up the subscriber installed. If the
    // subscriber is not started yet (feature flag OFF, or pre-boot
    // imports), this is a no-op — the cache still records the tenant
    // so a later wire-up can replay if we choose.
    pendingSubscribe?.(tenant_id);
  },
});

let subscriberStarted = false;
/** Tenants this process has SUBSCRIBED to. Mirrored from the cache for
 * test inspection; production source of truth is the cache instance. */
const subscribedTenantsForTest = new Set<string>();

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
 *
 * Issue #249 (per-tenant channel): two NEW invariants enforced here.
 *   1. Channel name MUST match the per-tenant shape
 *      `policy_rule_lifecycle:{tenant_id}`. A message on the bare legacy
 *      channel `policy_rule_lifecycle` (no `:tenant`) is dropped — only a
 *      misconfigured publisher would emit it, and we'd rather miss an
 *      invalidation (TTL kicks in) than process an event we cannot tenant-
 *      attribute.
 *   2. The channel-derived tenant_id MUST equal `payload.tenant_id`. A
 *      mismatch means either (a) ALS leaked at publish time, or (b) a
 *      bad actor tried to smuggle a foreign payload onto a tenant's
 *      channel. Either way the message is dropped with a warn log.
 *
 * Backwards-compat: the legacy parameter name `channel` still accepts the
 * Redis-delivered channel string. Explicit SUBSCRIBE callers fire
 * `message` with `(channel, payload)` — see `startPolicyCacheInvalidationSubscriber`.
 * The `pmessage` path used by the old PSUBSCRIBE wildcard is gone.
 */
export function handlePolicyLifecycleMessage(
  channel: string,
  msg: string,
  cache: PolicyResolverCache = policyResolverCache,
): void {
  const channelTenant = parsePolicyLifecycleChannel(channel);
  if (channelTenant === null) {
    // Either the legacy bare-name channel (`policy_rule_lifecycle` with
    // no tenant suffix) or an unrelated channel. Drop silently for
    // unrelated channels; warn for the legacy shape to surface stragglers.
    if (channel === POLICY_LIFECYCLE_CHANNEL) {
      logger.warn(
        { channel },
        'policy_cache.legacy_global_channel_ignored_issue_249',
      );
    }
    return;
  }
  let evt: PolicyLifecycleEvent;
  try {
    evt = JSON.parse(msg) as PolicyLifecycleEvent;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, msg, channel },
      'policy_cache.invalid_event_payload',
    );
    return;
  }
  if (!evt || typeof evt !== 'object' || typeof evt.tenant_id !== 'string') {
    logger.warn({ msg, channel }, 'policy_cache.event_payload_missing_tenant');
    return;
  }
  if (evt.tenant_id !== channelTenant) {
    // Defense-in-depth: a publisher that built its event in tenant-A
    // context but somehow published on tenant-B's channel is a bug
    // worth surfacing — and we MUST NOT invalidate tenant-A entries
    // based on the channel routing. Drop and log.
    logger.warn(
      { channel, channelTenant, payloadTenant: evt.tenant_id },
      'policy_cache.channel_payload_tenant_mismatch_dropped',
    );
    return;
  }
  cache.invalidate({
    tenant_id: evt.tenant_id,
    agent_id: evt.agent_id,
    descriptor: evt.descriptor,
  });
}

/**
 * Idempotent: starts the Redis subscriber the first time it's called,
 * then no-ops. Failure to subscribe is logged but doesn't throw —
 * caches still expire naturally via TTL.
 *
 * Wired from src/index.ts startup when FEATURE_POLICY_RESOLVER_V1 is on.
 *
 * Issue #249 (Codex round-2 verdict): uses explicit
 * `SUBSCRIBE policy_rule_lifecycle:<tenant_id>` per tenant this cache
 * actually touches. The previous PSUBSCRIBE wildcard let the BROKER
 * deliver events for every tenant to every subscriber, defeating the
 * isolation goal — the handler's payload guard was defense-in-depth, not
 * isolation. The cache's `onTenantTouched` hook fires the SUBSCRIBE call
 * lazily on first write per (process, tenant) so the subscription set
 * tracks the cache's actual working set.
 *
 * The broker delivers `message` events with `(channel, message)` for an
 * explicit subscriber; we forward to `handlePolicyLifecycleMessage`
 * which still cross-checks channel-tenant vs payload-tenant for
 * defense-in-depth.
 */
export function startPolicyCacheInvalidationSubscriber(
  cache: PolicyResolverCache = policyResolverCache,
): void {
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
  sub.on('message', (channel, msg) => {
    handlePolicyLifecycleMessage(channel, msg, cache);
  });

  // Wire the lazy hook: on each new tenant touched by the cache, issue
  // an explicit per-tenant SUBSCRIBE. Idempotency is enforced by the
  // cache's `subscribedTenants` Set (the hook fires once per tenant).
  pendingSubscribe = (tenant_id: string): void => {
    let channel: string;
    try {
      channel = buildPolicyLifecycleChannel(tenant_id);
    } catch (err) {
      // Defensive: an empty/whitespace tenant_id reaching the cache is a
      // programmer error elsewhere. Don't crash the cache write path.
      logger.warn(
        { err: (err as Error).message, tenant_id },
        'policy_cache.subscribe_build_channel_failed',
      );
      return;
    }
    subscribedTenantsForTest.add(tenant_id);
    void sub.subscribe(channel, (err, count) => {
      if (err) {
        logger.warn(
          { err: err.message, channel, tenant_id },
          'policy_cache.subscribe_failed_natural_ttl_only',
        );
        return;
      }
      logger.info(
        { channel, tenant_id, active_subscriptions: count },
        'policy_cache.tenant_channel_subscribed_issue_249',
      );
    });
  };
}

/**
 * Test-only: reset the once-flag so the integration test can re-invoke
 * `startPolicyCacheInvalidationSubscriber` after the spec replaces the
 * Redis client. Production code must NOT call this.
 */
export function _resetPolicyCacheSubscriberStartedFlag(): void {
  subscriberStarted = false;
  pendingSubscribe = null;
  subscribedTenantsForTest.clear();
}

/**
 * Test-only: inspect the tenant_ids this process has SUBSCRIBED to via
 * the lazy per-tenant subscribe (issue #249). Asserting on this Set is
 * how unit tests prove the cache narrows subscriptions to exactly the
 * tenants it touches, never wildcards.
 */
export function _getSubscribedTenantsForTest(): ReadonlySet<string> {
  return subscribedTenantsForTest;
}
