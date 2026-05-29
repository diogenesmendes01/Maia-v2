/**
 * Working memory — short-lived per-conversation buffers backed by Redis.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #231, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Every Redis key emitted by this module is prefixed with `tenant_id` AND
 * `agent_id`, both pulled from the AsyncLocalStorage tenant context via
 * `getCurrentTenant()` / `getCurrentAgent()`. There is NO fallback to a
 * "default" or empty namespace — if a caller forgets to wrap the operation
 * in `runWithTenantContext`, the underlying accessor throws a
 * `MissingTenantContextError`. That is a LOUD failure by design (consistent
 * with the procedural-memory mutators in `rulesRepo` after #230/#232): the
 * tenant boundary is INVIOLABLE, so masking a missing-context bug with a
 * shared fallback key is strictly worse than crashing.
 *
 * Defense-in-depth rationale (issue #231):
 *   Conversation IDs are UUIDs and (today) globally unique, so a missing
 *   namespace doesn't surface as an observable cross-tenant leak. But the
 *   invariant says "every state passes through tenant_id + agent_id, no
 *   exception" — and any future change to ID generation, or a future
 *   test/seed reusing fixed IDs across tenants, would silently reintroduce
 *   a real leak. Prefixing now eliminates that class of bug at the storage
 *   layer.
 *
 * Fail-closed guard order (Codex review #241 MAJOR #1):
 *   `getCurrentTenant()` / `getCurrentAgent()` MUST be called BEFORE the
 *   `isRedisConnected()` early-return. Otherwise, a Redis outage would let
 *   a missing-context caller bypass the tenant guard entirely (Redis down →
 *   function returns silently → accessor never fires → invariant violated).
 *   The accessors run first so a missing-context bug crashes loudly even
 *   when Redis is unavailable, matching the inviolable-isolation invariant.
 *
 * Key formats:
 *   working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Any pre-existing Redis entries under the OLD prefix (`working:conv:…`)
 * are no longer reachable through the public API and will age out via the
 * existing 24h TTL on the message buffer. No explicit migration job is
 * required — the data is short-lived by construction and the buffers are
 * rebuilt from the inbound stream within one conversation.
 *
 * Note on the removed `rateLimit` helper (#270/#274): a prior `rateLimit`
 * export was removed as dead code (no callers in repo, fail-open on
 * Redis-down, INCR/EXPIRE race, no tenant scope). Do NOT resurrect it
 * here. If working-memory ever needs an agent-scoped limiter, follow the
 * PR #258 gateway pattern (Lua/MULTI atomicity, fail-CLOSED on Redis-down,
 * `maia:ratelimit:${tenant_id}:${agent_id}:...` key prefix).
 *
 * Observability (issue #286):
 *   - working_memory_read_latency_ms{key_type, hit}  histogram on readRecent
 *   - working_memory_ttl_miss_total{key_type}        counter — wrote a key
 *     whose TTL has not yet elapsed, yet the read returned empty (eviction,
 *     FLUSHDB, crash before EXPIRE landed). Process-local detector — does
 *     not catch cross-instance misses, by design.
 *   - working_memory_legacy_read_total{key_type}     counter — vestigial
 *     after #241 removed the legacy fallback path (Option A). Preserved as a
 *     0-emit safety counter so any future caller that reintroduces the legacy
 *     key shape surfaces immediately on dashboards. See `recordLegacyRead`.
 *
 *   Cardinality is intentionally low: only `key_type` (closed set: "messages",
 *   "rate") and `hit` ("0"|"1") appear as labels. Raw `tenant_id` /
 *   `conversa_id` are NOT labels — per #286 that would explode label
 *   cardinality on a hot path. Per-tenant attribution flows via the
 *   structured log alongside each metric increment.
 */
import { redis, isRedisConnected } from '@/lib/redis.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';

/**
 * Key-type label vocabulary for working-memory observability counters and
 * histograms. Kept narrow on purpose — Prometheus label cardinality is a
 * product of every label value, and working memory is hot-path.
 *
 * - `messages` — the per-conversation rolling message buffer (this file).
 * - `rate`     — reserved for any future per-tenant rate-limit counter if/when
 *                working-memory grows one back (#270 removed the old helper).
 *                Keeping the label value in the closed set means the
 *                observability surface won't churn if a limiter lands here.
 */
export type WorkingMemoryKeyType = 'messages' | 'rate';

const MESSAGES_TTL_SECONDS = 60 * 60 * 24;

/**
 * Process-local tracker for TTL-miss detection (#286).
 *
 * The contract: when we WRITE to a working-memory key we record the wall-clock
 * deadline at which the entry would naturally expire. On READ, if the key
 * returns empty AND we still have a non-expired write record, that's a TTL
 * miss — the entry vanished early (eviction, FLUSHDB, crash before EXPIRE
 * commit, or a partial write that never landed). We increment a counter so
 * dashboards can alarm on it.
 *
 * Scope caveats:
 *   - Process-local map: this catches misses within ONE instance's lifetime.
 *     Cross-instance reads (write on app-1, read on app-2) cannot be detected
 *     here — but that's an acceptable trade-off vs. the alternative (a Redis
 *     sentinel key, which would double write QPS for a defense metric).
 *   - We prune lazily on read; size is bounded by active conversation count
 *     (~hundreds at peak) so a periodic sweep is unnecessary.
 *   - The map is keyed by the FULLY-SCOPED redis key (incl. tenant_id and
 *     agent_id), so cross-tenant collisions on `conversa_id` are impossible
 *     by construction — the namespace #241 introduced doubles as a
 *     disambiguator for this tracker.
 */
const writeDeadlines = new Map<string, number>();

function recordWrite(redisKey: string, ttlSeconds: number): void {
  writeDeadlines.set(redisKey, Date.now() + ttlSeconds * 1000);
}

function consumeWriteRecord(redisKey: string): boolean {
  const deadline = writeDeadlines.get(redisKey);
  if (deadline === undefined) return false;
  // Delete unconditionally — a record is "consumed" by the first miss-of-write
  // it ever sees. Repeated misses against the same key after an eviction event
  // would otherwise double-count the same incident.
  writeDeadlines.delete(redisKey);
  if (deadline <= Date.now()) {
    // Natural expiry — drop the record but do NOT count as a miss.
    return false;
  }
  return true;
}

function workingMessagesKey(conversa_id: string): string {
  // `getCurrentTenant()` / `getCurrentAgent()` throw `MissingTenantContextError`
  // if the caller isn't wrapped in `runWithTenantContext` — see invariant block.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages`;
}

export async function pushMessage(
  conversa_id: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  // Resolve the scoped key BEFORE the Redis-availability check. Calling the
  // tenant accessors first guarantees a missing-context caller crashes loudly
  // (MissingTenantContextError) even when Redis is down — Codex #241 MAJOR #1.
  const key = workingMessagesKey(conversa_id);
  if (!isRedisConnected()) return;
  await redis.rpush(key, JSON.stringify({ role, text, ts: Date.now() }));
  await redis.ltrim(key, -20, -1);
  await redis.expire(key, MESSAGES_TTL_SECONDS);
  recordWrite(key, MESSAGES_TTL_SECONDS);
}

export async function readRecent(
  conversa_id: string,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  // Resolve the scoped key BEFORE the Redis-availability check — same rationale
  // as `pushMessage`. Missing tenant context must crash, not fall through.
  const key = workingMessagesKey(conversa_id);
  if (!isRedisConnected()) return [];
  const startedAt = Date.now();

  let items: string[] = [];
  try {
    items = await redis.lrange(key, 0, -1);
  } finally {
    const elapsed = Date.now() - startedAt;
    const hit = items.length > 0 ? '1' : '0';
    observeHistogram('working_memory_read_latency_ms', elapsed, {
      key_type: 'messages',
      hit,
    });
    if (items.length === 0 && consumeWriteRecord(key)) {
      // Wrote a key whose TTL has NOT yet elapsed, yet the read returned
      // nothing — entry vanished early. Surface as a defense metric so
      // operators can correlate with Redis eviction / restart events.
      incCounter('working_memory_ttl_miss_total', { key_type: 'messages' });
      logger.warn(
        { key_type: 'messages' },
        'working_memory.ttl_miss',
      );
    } else if (items.length > 0) {
      // Successful read on a key we wrote to — clear the deadline so the map
      // stays bounded by active conversations rather than total writes.
      writeDeadlines.delete(key);
    }
  }

  return items
    .map((s) => {
      try {
        return JSON.parse(s) as { role: 'user' | 'assistant'; text: string };
      } catch {
        return null;
      }
    })
    .filter((x): x is { role: 'user' | 'assistant'; text: string } => x !== null);
}

/**
 * Increment the legacy-read counter (#286).
 *
 * Vestigial after #241 (v3 Option A) — the legacy `working:conv:${conversa_id}:`
 * key shape and its fallback branch were removed entirely from this module.
 * There are NO in-tree callers; the helper is preserved as a 0-emit safety
 * counter and a one-call ingress point. If a future change accidentally
 * resurrects a non-tenant-scoped read path, wiring it through
 * `recordLegacyRead('messages' | 'rate')` will surface the regression on
 * existing dashboards without operators having to add a new metric.
 *
 * Labels:
 *   working_memory_legacy_read_total{key_type="messages"|"rate"}
 *
 * Cardinality: only `key_type` is labelled. Per #286, raw `tenant_id` is
 * intentionally NOT a label (cardinality risk on a hot path). When the
 * counter is non-zero, operators correlate via the structured log emitted
 * here (logger level `info`, redacted by default).
 */
export function recordLegacyRead(key_type: WorkingMemoryKeyType): void {
  incCounter('working_memory_legacy_read_total', { key_type });
  logger.info({ key_type }, 'working_memory.legacy_read');
}

/**
 * Test-only: clear the in-process write-deadline tracker so specs that share
 * a module instance don't see stale TTL records leak across cases. Not part
 * of the public API.
 */
export function _resetWriteDeadlinesForTests(): void {
  writeDeadlines.clear();
}
