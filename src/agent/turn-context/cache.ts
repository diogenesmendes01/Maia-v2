/**
 * Issue #511 — versioned, tenant-scoped cache for the STATIC half of the turn
 * context, with cross-replica invalidation.
 *
 * ## What may be cached, and why the list is closed
 *
 * `CACHEABLE_RESOURCES` is an exhaustive union, not a convention. The issue's
 * §5 draws a hard line: identity, roles, active procedure definitions, the
 * skills catalogue and versioned configuration may be cached; recent messages,
 * media, pending confirmations, balances, financial state and — above all —
 * AUTHORIZATION may not.
 *
 * Making that a TYPE rather than a code review note is the point. A future
 * change that tries to cache permissions does not compile. This matters more
 * than any TTL choice, because it is the property that makes a Redis outage
 * survivable: no cached value can carry a grant, so no cached value can keep a
 * REVOKED grant alive. `resolveScope` and the dispatcher's execution-time
 * re-check both read straight from Postgres, every turn, cache or no cache.
 *
 * ## Keys
 *
 * `maia:turn_ctx:v1:{tenant_id}:{agent_id}:{resource}` — built through the
 * central `buildCacheKey` (#287) so a `:` inside an id cannot alias two tuples
 * onto one slot, and glob metacharacters stay literal.
 *
 * Fail-closed on the scope (invariant #2): an empty, whitespace-only or
 * `'default'` tenant/agent THROWS instead of producing a degenerate key. A key
 * like `…:v1:acme::identity` is a tenant-wide bucket that two different agents
 * would share — the exact cross-agent collision that issue #235 closed for the
 * slice cache. Rejecting it loudly beats serving one agent another's identity.
 *
 * The `v1` segment is the cache SHAPE version: changing what a section holds
 * bumps it, so a deploy cannot read the previous shape back as the new type.
 *
 * ## Staleness bounds
 *
 * Three independent bounds, in order of speed:
 *   1. explicit invalidation published by the mutation site AFTER commit,
 *      fanned out to every replica over Redis pub/sub;
 *   2. the positive TTL, which caps staleness when Redis is unreachable;
 *   3. the LRU cap, which bounds memory rather than staleness.
 *
 * Negative entries ("no active profile") are cached too — otherwise an agent
 * mid-setup pays a full DB read every turn to learn the same nothing — but at a
 * much shorter TTL, so activating a profile is visible in seconds.
 *
 * Structure follows `src/control-plane/policy/policy-cache.ts` deliberately:
 * per-tenant explicit SUBSCRIBE (never a PSUBSCRIBE wildcard, so the BROKER
 * never routes one tenant's events to another's subscriber — issue #249), lazy
 * subscription on first write for a tenant, and a channel/payload tenant
 * cross-check in the handler as defence in depth.
 */
import { config } from '@/config/env.js';
import { buildCacheKey } from '@/lib/cache-key.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
// Every `CacheableResource` is also a `TurnContextSection`, so the resource
// name doubles as the metric label with no mapping table to drift.
import { recordCacheOutcome } from './metrics.js';

/**
 * The closed set of cacheable sections. See the header: this union is the
 * enforcement mechanism for "never cache authorization", so adding a member is
 * a security decision, not a performance one.
 *
 *  - `identity`     — active operational profile / self state. Changes only
 *                     through an audited activation, which publishes.
 *  - `capabilities` — skills catalogue + mentionable gaps. Descriptive
 *                     self-knowledge; grants nothing. NOTE: the skill CATALOGUE
 *                     is not the skill GRANT — what an agent may actually run
 *                     is re-resolved per turn by the runtime tool filter and
 *                     re-checked by the dispatcher, neither of which reads this.
 *  - `gaps`         — the mentionable/proposed gap list rendered as the
 *                     "known limitations" block. Pure transparency copy.
 *
 * Each resource is loaded ATOMICALLY: a load that throws is not cached at all,
 * so a partially-failed section can never be pinned for a TTL.
 */
export const CACHEABLE_RESOURCES = ['identity', 'capabilities', 'gaps'] as const;
export type CacheableResource = (typeof CACHEABLE_RESOURCES)[number];

/** Cache shape version. Bump when a cached section's payload changes shape. */
export const TURN_CONTEXT_CACHE_VERSION = 'v1';

const KEY_PREFIX = `maia:turn_ctx:${TURN_CONTEXT_CACHE_VERSION}:`;
const CHANNEL_PREFIX = 'maia:turn_ctx_invalidation:';

/** Sentinel stored for a "known absent" value, distinct from any real payload. */
const ABSENT = Symbol('turn_context_absent');

export class InvalidCacheScopeError extends Error {
  readonly code = 'INVALID_TURN_CONTEXT_CACHE_SCOPE';
  constructor(field: 'tenant_id' | 'agent_id', reason: string) {
    super(
      `turn-context cache: ${field} is ${reason}. Refusing to build a cache key — a degenerate ` +
        `segment collapses distinct tenants/agents onto one entry (cross-tenant read).`,
    );
    this.name = 'InvalidCacheScopeError';
  }
}

function assertUsableScopeSegment(value: string, field: 'tenant_id' | 'agent_id'): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidCacheScopeError(field, 'empty or whitespace-only');
  }
  // `'default'` is the legacy single-tenant sentinel (issue #282/#323). Any
  // path still carrying it is presumed misrouted, and caching under it would
  // merge every such path into one shared bucket.
  if (value === 'default') {
    throw new InvalidCacheScopeError(field, "the legacy 'default' literal");
  }
}

export function turnContextCacheKey(
  tenant_id: string,
  agent_id: string,
  resource: CacheableResource,
): string {
  assertUsableScopeSegment(tenant_id, 'tenant_id');
  assertUsableScopeSegment(agent_id, 'agent_id');
  return buildCacheKey(KEY_PREFIX, tenant_id, agent_id, resource);
}

export function turnContextInvalidationChannel(tenant_id: string): string {
  assertUsableScopeSegment(tenant_id, 'tenant_id');
  return buildCacheKey(CHANNEL_PREFIX, tenant_id);
}

/**
 * Recover the tenant a channel name refers to. Returns `null` for anything that
 * is not one of our per-tenant channels, so an unrelated message can never
 * invalidate anything.
 */
export function parseTurnContextInvalidationChannel(channel: string): string | null {
  if (!channel.startsWith(CHANNEL_PREFIX)) return null;
  const encoded = channel.slice(CHANNEL_PREFIX.length);
  if (encoded.length === 0 || encoded.includes(':')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export type TurnContextInvalidationEvent = {
  tenant_id: string;
  /** `null` invalidates the resource for EVERY agent of the tenant. */
  agent_id: string | null;
  resource: CacheableResource;
  occurred_at: string;
};

type Entry = {
  value: unknown;
  expires_at: number;
};

export type TurnContextCacheStats = {
  hits: number;
  misses: number;
  negative_hits: number;
  entries: number;
  evictions: number;
};

export type TurnContextCacheConfig = {
  ttl_ms: number;
  negative_ttl_ms: number;
  max_entries: number;
  /** Fired once per (instance, tenant) on first write — drives lazy SUBSCRIBE. */
  onTenantTouched?: (tenant_id: string) => void;
};

/**
 * In-process TTL cache with insertion-order eviction.
 *
 * A `Map` iterates in insertion order, so evicting `keys().next()` drops the
 * OLDEST entry. That is FIFO, not true LRU — chosen on purpose: the working set
 * here is at most two entries per (tenant, agent), so recency tracking would
 * cost more than it saves, and the eviction path is effectively dead in any
 * realistic deployment. The cap exists to bound memory if the tuple count ever
 * explodes, not to optimise a hit rate.
 */
export class TurnContextCache {
  private readonly store = new Map<string, Entry>();
  private readonly touchedTenants = new Set<string>();
  private hits = 0;
  private misses = 0;
  private negativeHits = 0;
  private evictions = 0;

  constructor(private readonly cfg: TurnContextCacheConfig) {}

  /**
   * Read `resource` for the CURRENT ALS tenant/agent, loading it on a miss.
   *
   * `load` returning `null` is cached as a negative entry at the shorter TTL —
   * "no active profile" is a real answer worth remembering, but not for long.
   *
   * A cache failure must never fail a turn: any throw from the cache layer
   * itself is logged, metered as `error`, and the loader runs anyway. A throw
   * from `load` propagates untouched — that is the caller's dependency failing,
   * and the caller decides whether it is critical or degradable.
   */
  async getOrLoad<T>(
    resource: CacheableResource,
    load: () => Promise<T | null>,
  ): Promise<T | null> {
    let scoped: { key: string; tenant_id: string };
    try {
      const tenant_id = getCurrentTenant();
      scoped = { key: turnContextCacheKey(tenant_id, getCurrentAgent(), resource), tenant_id };
    } catch (err) {
      // Missing/degenerate scope: do NOT cache, but do not break the turn
      // either — the read itself is tenant-guarded downstream and will fail
      // closed on its own if the context is truly unusable.
      recordCacheOutcome(resource, 'error');
      logger.warn(
        { err: (err as Error).message, resource },
        'turn_context_cache.scope_unusable_bypassed',
      );
      return load();
    }

    const hit = this.peek(scoped.key);
    if (hit !== undefined) {
      if (hit === ABSENT) {
        this.negativeHits++;
        recordCacheOutcome(resource, 'negative_hit');
        return null;
      }
      this.hits++;
      recordCacheOutcome(resource, 'hit');
      return hit as T;
    }

    this.misses++;
    recordCacheOutcome(resource, 'miss');
    const loaded = await load();
    this.put(scoped.key, loaded === null || loaded === undefined ? ABSENT : loaded);
    this.notifyTenantTouched(scoped.tenant_id);
    return loaded ?? null;
  }

  /** Drop entries for a tenant (all agents when `agent_id` is null). */
  invalidate(args: {
    tenant_id: string;
    agent_id: string | null;
    resource: CacheableResource;
  }): number {
    if (args.agent_id !== null) {
      const key = turnContextCacheKey(args.tenant_id, args.agent_id, args.resource);
      return this.store.delete(key) ? 1 : 0;
    }
    // Tenant-wide: the agent segment is unknown, so match on the encoded
    // prefix. Encoding the tenant through the SAME builder is what stops
    // tenant `acme` from clearing tenant `acme:dev` (delimiter aliasing, #287).
    const prefix = buildCacheKey(KEY_PREFIX, args.tenant_id) + ':';
    const suffix = ':' + buildCacheKey('', args.resource);
    let dropped = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.store.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  invalidateAll(): void {
    this.store.clear();
  }

  stats(): TurnContextCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      negative_hits: this.negativeHits,
      entries: this.store.size,
      evictions: this.evictions,
    };
  }

  /** Test helper: reset counters and contents. */
  resetForTests(): void {
    this.store.clear();
    this.touchedTenants.clear();
    this.hits = 0;
    this.misses = 0;
    this.negativeHits = 0;
    this.evictions = 0;
  }

  private peek(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires_at <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private put(key: string, value: unknown): void {
    const ttl = value === ABSENT ? this.cfg.negative_ttl_ms : this.cfg.ttl_ms;
    this.store.delete(key);
    this.store.set(key, { value, expires_at: Date.now() + ttl });
    while (this.store.size > this.cfg.max_entries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
      this.evictions++;
    }
  }

  private notifyTenantTouched(tenant_id: string): void {
    if (this.touchedTenants.has(tenant_id)) return;
    this.touchedTenants.add(tenant_id);
    try {
      this.cfg.onTenantTouched?.(tenant_id);
    } catch (err) {
      // A failed subscribe only means this tenant falls back to TTL-bounded
      // staleness. It must never break the read path.
      logger.warn(
        { err: (err as Error).message, tenant_id },
        'turn_context_cache.on_tenant_touched_hook_failed',
      );
    }
  }
}

// ============================================================================
// Process singleton + Redis wiring
// ============================================================================

let pendingSubscribe: ((tenant_id: string) => void) | null = null;

export const turnContextCache = new TurnContextCache({
  ttl_ms: config.TURN_CONTEXT_CACHE_TTL_MS,
  negative_ttl_ms: config.TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS,
  max_entries: config.TURN_CONTEXT_CACHE_MAX_ENTRIES,
  onTenantTouched: (tenant_id) => pendingSubscribe?.(tenant_id),
});

/**
 * Cache-aware read used by the loader.
 *
 * With `FEATURE_TURN_CONTEXT_CACHE` off this is a straight pass-through that
 * still records a `bypass` outcome, so the metric distinguishes "cache
 * disabled" from "cache missing" — an operator looking at a zero hit-rate
 * should be able to tell which one they are looking at.
 */
export async function readCached<T>(
  resource: CacheableResource,
  load: () => Promise<T | null>,
  cache: TurnContextCache = turnContextCache,
): Promise<T | null> {
  if (!config.FEATURE_TURN_CONTEXT_CACHE) {
    recordCacheOutcome(resource, 'bypass');
    return load();
  }
  return cache.getOrLoad(resource, load);
}

/**
 * Publish an invalidation to every replica. Call AFTER the mutation commits —
 * publishing before commit races the readers, which would repopulate the cache
 * from the pre-commit snapshot and pin the stale value for a full TTL.
 *
 * Best-effort by contract: a Redis failure degrades to TTL-bounded staleness,
 * which is acceptable precisely because nothing authorization-bearing is
 * cached. It never throws into the mutation's caller — the write already
 * happened, and failing the operator's activation because a cache hint could
 * not be published would be the worse outcome.
 */
export async function publishTurnContextInvalidation(args: {
  tenant_id: string;
  agent_id: string | null;
  resource: CacheableResource;
  /** Injected in tests; defaults to the shared client. */
  publisher?: { publish: (channel: string, message: string) => Promise<unknown> };
}): Promise<void> {
  const event: TurnContextInvalidationEvent = {
    tenant_id: args.tenant_id,
    agent_id: args.agent_id,
    resource: args.resource,
    occurred_at: new Date().toISOString(),
  };
  // Apply locally first: this replica must not serve a stale value even if the
  // broker is unreachable.
  turnContextCache.invalidate(event);
  try {
    const client = args.publisher ?? (await import('@/lib/redis.js')).redis;
    await client.publish(turnContextInvalidationChannel(args.tenant_id), JSON.stringify(event));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenant_id: args.tenant_id, resource: args.resource },
      'turn_context_cache.invalidation_publish_failed_ttl_only',
    );
  }
}

/**
 * Pure handler, extracted so a unit test can exercise the SUBSCRIBE side of the
 * bus without standing up Redis — the half that historically went untested.
 */
export function handleTurnContextInvalidationMessage(
  channel: string,
  message: string,
  cache: TurnContextCache = turnContextCache,
): void {
  const channelTenant = parseTurnContextInvalidationChannel(channel);
  if (channelTenant === null) return;

  let event: TurnContextInvalidationEvent;
  try {
    event = JSON.parse(message) as TurnContextInvalidationEvent;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel },
      'turn_context_cache.invalid_event_payload',
    );
    return;
  }
  if (!event || typeof event.tenant_id !== 'string') {
    logger.warn({ channel }, 'turn_context_cache.event_payload_missing_tenant');
    return;
  }
  if (event.tenant_id !== channelTenant) {
    // Either a publisher bug or an attempt to smuggle a foreign payload onto a
    // tenant's channel. Dropping is right: acting on it would let one tenant
    // flush another's cache.
    logger.warn(
      { channel, channelTenant, payloadTenant: event.tenant_id },
      'turn_context_cache.channel_payload_tenant_mismatch_dropped',
    );
    return;
  }
  if (!(CACHEABLE_RESOURCES as readonly string[]).includes(event.resource)) {
    logger.warn({ channel, resource: event.resource }, 'turn_context_cache.unknown_resource');
    return;
  }
  cache.invalidate({
    tenant_id: event.tenant_id,
    agent_id: typeof event.agent_id === 'string' ? event.agent_id : null,
    resource: event.resource,
  });
}

let subscriberStarted = false;
const subscribedTenantsForTest = new Set<string>();

/**
 * Idempotent. Starts a dedicated subscriber connection (ioredis forbids other
 * commands on a subscribed client) and wires the lazy per-tenant SUBSCRIBE.
 *
 * No-op when the cache feature is off: with nothing cached there is nothing to
 * invalidate, and an idle connection per replica is not free.
 */
export function startTurnContextCacheInvalidationSubscriber(
  cache: TurnContextCache = turnContextCache,
): void {
  if (subscriberStarted) return;
  if (!config.FEATURE_TURN_CONTEXT_CACHE) return;
  subscriberStarted = true;

  // `ioredis` is imported lazily so this module stays cheap for the hot path:
  // `prompt-builder.ts` pulls it in on every turn just to call `readCached`,
  // and a top-level driver import would drag the client into that graph (and
  // into every prompt-builder unit spec) for no reason.
  void (async () => {
    const { default: IORedis } = await import('ioredis');
    const sub = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    sub.on('error', (err) => {
      logger.warn({ err: err.message }, 'turn_context_cache.subscriber_error');
    });
    sub.connect().catch((err) => {
      logger.warn(
        { err: (err as Error).message },
        'turn_context_cache.subscribe_connect_failed',
      );
    });
    sub.on('message', (channel, message) => {
      handleTurnContextInvalidationMessage(channel, message, cache);
    });

    pendingSubscribe = (tenant_id: string): void => {
      let channel: string;
      try {
        channel = turnContextInvalidationChannel(tenant_id);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, tenant_id },
          'turn_context_cache.subscribe_build_channel_failed',
        );
        return;
      }
      subscribedTenantsForTest.add(tenant_id);
      void sub.subscribe(channel, (err) => {
        if (err) {
          logger.warn(
            { err: err.message, channel, tenant_id },
            'turn_context_cache.subscribe_failed_natural_ttl_only',
          );
        }
      });
    };
  })().catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      'turn_context_cache.subscriber_start_failed_ttl_only',
    );
  });
}

/** Test-only: reset the once-flag so a spec can re-wire the subscriber. */
export function _resetTurnContextSubscriberForTests(): void {
  subscriberStarted = false;
  pendingSubscribe = null;
  subscribedTenantsForTest.clear();
}

/** Test-only: which tenants this process explicitly SUBSCRIBEd to. */
export function _getSubscribedTenantsForTest(): ReadonlySet<string> {
  return subscribedTenantsForTest;
}

export const _internal = { ABSENT, KEY_PREFIX, CHANNEL_PREFIX };
