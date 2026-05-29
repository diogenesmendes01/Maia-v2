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
 * This applies to BOTH the message-buffer key AND the TTL/collision marker
 * key (`nx_ttl:…`, see below) — neither is ever written under a shared scope.
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
 *   working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages   (data)
 *   nx_ttl:${tenant_id}:${agent_id}:conv:${conversa_id}:messages    (marker)
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
 * Observability (issues #286 + #317):
 *   - working_memory_read_latency_ms{key_type, hit}  histogram on readRecent
 *     (recorded ONLY after a SUCCESSFUL lrange — a Redis failure has no
 *     meaningful hit/miss outcome to attribute, see #317 B1).
 *   - working_memory_ttl_miss_total{key_type}        counter — wrote a key
 *     whose TTL marker is still present, yet the read returned empty
 *     (eviction, FLUSHDB, crash before EXPIRE landed). See #317 B3/B4.
 *   - working_memory_key_collision_total{key_type}   counter — the read
 *     observed a TTL marker whose stored scope-fingerprint does NOT match the
 *     fingerprint recomputed from the CURRENT tenant context for the SAME
 *     physical Redis key. That means two distinct logical scopes hashed onto
 *     one key (a missing-prefix legacy path, a future ID-generation change, a
 *     truncated-hash bug). It is the working-memory analogue of the
 *     idempotency payload-hash revalidation (#299/#301). This is the central
 *     ask of #286 ("condições de colisão potencial"). See #317 B2.
 *   - working_memory_redis_error_total{key_type, op} counter — a Redis call
 *     (`lrange`/`get`/`set`) threw. Recorded SEPARATELY so a transient Redis
 *     failure is NEVER miscounted as a TTL miss (#317 B1).
 *   - working_memory_legacy_read_total{key_type}     counter — vestigial
 *     after #241 removed the legacy fallback path (Option A). Preserved as a
 *     0-emit safety counter so any future caller that reintroduces the legacy
 *     key shape surfaces immediately on dashboards. See `recordLegacyRead`.
 *
 *   Cardinality is intentionally low: only `key_type` (closed set: "messages",
 *   "rate"), `hit` ("0"|"1") and `op` ("lrange"|"get"|"set", closed set)
 *   appear as labels. Raw `tenant_id` / `agent_id` / `conversa_id` are NOT
 *   labels — per #286 that would explode label cardinality on a hot path.
 *   Per-tenant attribution flows via the structured log alongside each metric
 *   increment.
 *
 * TTL-miss / collision tracker design (issue #317 B3/B4 — owner design call):
 *   The previous detector (#286/#304) used a module-level `Map<string,number>`
 *   of write deadlines. That had three flaws this module now fixes:
 *     - B4 — process-local. A write on worker A and a read on worker B (or a
 *       restart between them) lost the deadline, silently under-counting.
 *     - N1 — unbounded growth. Write-only conversations (written, never read)
 *       accumulated forever; only a read/miss deleted the entry.
 *     - B3 — a successful read deleted the deadline, hiding any eviction that
 *       happened AFTER a hit but BEFORE the natural 24h expiry.
 *   The replacement is a Redis-backed TTL marker written alongside every data
 *   write: `SET nx_ttl:${scope} <fingerprint> EX 86400`. The marker:
 *     - survives worker boundaries and restarts (it lives in Redis), so
 *       cross-worker write/read pairs are now detectable (B4);
 *     - is bounded by Redis' own TTL — it expires exactly when the data would,
 *       so write-only conversations cannot leak memory (N1, no sweep needed);
 *     - is NOT deleted on a successful read, so the push→hit→evict→miss cycle
 *       stays observable until natural expiry or overwrite (B3);
 *     - stores a scope fingerprint (not just "1"), which doubles as the
 *       key-collision detector (B2).
 *   The marker is a tiny separate key; a Redis eviction that drops the data
 *   list does not necessarily drop the marker (and vice-versa), which is
 *   exactly what lets an empty-read-with-live-marker be recognised as a miss.
 */
import {
  redis,
  isRedisConnected,
  isRedisOomError,
  recordRedisOomDegraded,
} from '@/lib/redis.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { sha256 } from '@/lib/utils.js';

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

/**
 * Closed set of Redis op labels for `working_memory_redis_error_total`.
 * Kept narrow for the same cardinality reason as `key_type` — these are the
 * only Redis verbs this module issues.
 */
type WorkingMemoryRedisOp = 'lrange' | 'get' | 'set';

const MESSAGES_TTL_SECONDS = 60 * 60 * 24;

function workingMessagesKey(conversa_id: string): string {
  // `getCurrentTenant()` / `getCurrentAgent()` throw `MissingTenantContextError`
  // if the caller isn't wrapped in `runWithTenantContext` — see invariant block.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages`;
}

/**
 * TTL/collision marker key for a conversation buffer (#317).
 *
 * Deliberately a DIFFERENT prefix (`nx_ttl:`) from the data key so the two are
 * independent in Redis — an eviction can drop one without the other, which is
 * the signal we exploit to recognise a post-write eviction. Still fully
 * tenant+agent scoped: the marker is per-conversation state and the inviolable
 * isolation invariant applies to it exactly as it does to the data key.
 */
function workingMarkerKey(conversa_id: string): string {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `nx_ttl:${tenant_id}:${agent_id}:conv:${conversa_id}:messages`;
}

/**
 * Scope fingerprint stored as the marker VALUE (#317 B2).
 *
 * A SHA-256 of the fully-scoped tuple `(tenant_id, agent_id, conversa_id)`.
 * On read we recompute it from the CURRENT tenant context and compare against
 * the value the marker carries. A mismatch means the same physical Redis key
 * was written under a different logical scope — a key collision. Segments are
 * URI-encoded before joining so a `:` inside any id (not possible with the
 * admin-UI slug charset, but defense-in-depth — mirrors `idempotency.ts`)
 * cannot let `(a, b)` alias into `(a:b)`.
 */
function scopeFingerprint(conversa_id: string): string {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return sha256(
    [tenant_id, agent_id, conversa_id].map((s) => encodeURIComponent(s)).join('|'),
  );
}

function recordRedisError(op: WorkingMemoryRedisOp): void {
  incCounter('working_memory_redis_error_total', { key_type: 'messages', op });
  logger.warn({ key_type: 'messages', op }, 'working_memory.redis_error');
}

export async function pushMessage(
  conversa_id: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  // Resolve the scoped keys BEFORE the Redis-availability check. Calling the
  // tenant accessors first guarantees a missing-context caller crashes loudly
  // (MissingTenantContextError) even when Redis is down — Codex #241 MAJOR #1.
  const key = workingMessagesKey(conversa_id);
  const markerKey = workingMarkerKey(conversa_id);
  const fingerprint = scopeFingerprint(conversa_id);
  if (!isRedisConnected()) return;

  // OOM handling (#309): working memory is a CACHE — Postgres is the source of
  // truth (the buffer is rebuilt from persisted `mensagens` on the next turn;
  // see the file docblock and runbook §4.5). On a Redis OOM under `noeviction`
  // we degrade FAIL-OPEN: skip the data write, emit the OOM metric + warning,
  // and return WITHOUT writing the TTL/collision marker (the buffer never
  // landed, so a marker would manufacture a false TTL miss on the next read).
  // Fail-open is safe here: the key is already tenant+agent-scoped (no
  // isolation risk in dropping a write) and the read path falls back to
  // Postgres on the resulting cache miss. Any NON-OOM Redis error still
  // propagates — we only absorb the capacity signal.
  try {
    await redis.rpush(key, JSON.stringify({ role, text, ts: Date.now() }));
    await redis.ltrim(key, -20, -1);
    await redis.expire(key, MESSAGES_TTL_SECONDS);
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('working_memory.push', {
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
        key_type: 'messages',
      });
      return;
    }
    throw err;
  }

  // Write the TTL/collision marker alongside the data, with the SAME TTL so it
  // ages out exactly when the buffer would (#317 N1: bounded by Redis, no
  // in-process map to leak). Overwrite (no NX) so a re-used conversa_id under a
  // fresh write refreshes both the TTL and the fingerprint. Marker failures are
  // a degraded-observability event, never a write failure for the caller.
  //
  // OOM on the marker (#309): the DATA write already succeeded above, so the
  // buffer is present and correct — only the observability marker is missing.
  // We record the OOM degradation (capacity signal) and return; we do NOT also
  // emit `working_memory_redis_error_total` for the same event. A subsequent
  // read simply won't have a marker to detect a future eviction (degraded
  // observability), which is strictly better than crashing the turn.
  try {
    await redis.set(markerKey, fingerprint, 'EX', MESSAGES_TTL_SECONDS);
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('working_memory.push', {
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
        key_type: 'messages',
      });
      return;
    }
    recordRedisError('set');
  }
}

export async function readRecent(
  conversa_id: string,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  // Resolve the scoped keys BEFORE the Redis-availability check — same
  // rationale as `pushMessage`. Missing tenant context must crash, not fall
  // through.
  const key = workingMessagesKey(conversa_id);
  const markerKey = workingMarkerKey(conversa_id);
  if (!isRedisConnected()) return [];
  const startedAt = Date.now();

  // ---------------------------------------------------------------------------
  // Step 1: the data read. A Redis failure here is recorded under a SEPARATE
  // metric and rethrown — it is NEVER folded into the TTL-miss counter
  // (#317 B1). Miss/collision detection runs ONLY on the success path below,
  // not in a `finally`, so a thrown lrange can't masquerade as an empty read.
  // ---------------------------------------------------------------------------
  let items: string[];
  try {
    items = await redis.lrange(key, 0, -1);
  } catch (err) {
    recordRedisError('lrange');
    throw err;
  }

  // Success path: the latency observation gets a meaningful hit/miss label.
  const elapsed = Date.now() - startedAt;
  const hit = items.length > 0 ? '1' : '0';
  observeHistogram('working_memory_read_latency_ms', elapsed, {
    key_type: 'messages',
    hit,
  });

  // ---------------------------------------------------------------------------
  // Step 2: consult the TTL/collision marker (#317 B2/B3/B4). Best-effort — a
  // marker read failure degrades observability only, never the data result.
  // ---------------------------------------------------------------------------
  let marker: string | null = null;
  try {
    marker = await redis.get(markerKey);
  } catch {
    recordRedisError('get');
  }

  if (marker !== null) {
    const expected = scopeFingerprint(conversa_id);
    if (marker !== expected) {
      // Same physical key, different logical scope. Surface as a collision and
      // do NOT also count it as a TTL miss — an empty read here is explained by
      // the foreign scope, not by an eviction of OUR write.
      incCounter('working_memory_key_collision_total', { key_type: 'messages' });
      logger.warn({ key_type: 'messages' }, 'working_memory.key_collision');
    } else if (items.length === 0) {
      // Our own marker is still alive (TTL not elapsed) yet the buffer read
      // returned nothing — the entry vanished early (eviction, FLUSHDB, crash
      // before EXPIRE commit, or a partial write). Surface as a defense metric.
      // The marker is intentionally NOT deleted here so a later eviction after
      // a hit is still observable until natural expiry/overwrite (#317 B3).
      incCounter('working_memory_ttl_miss_total', { key_type: 'messages' });
      logger.warn({ key_type: 'messages' }, 'working_memory.ttl_miss');
    }
  }
  // marker === null → cold read or natural expiry; NOT a miss (#317 B1/N1).

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
 * Test-only no-op retained for backwards compatibility (#317).
 *
 * The in-process write-deadline `Map` it used to clear was removed in #317 —
 * the TTL-miss/collision tracker is now Redis-backed (see the design block
 * above). Specs that share a module instance reset state by flushing the Redis
 * stub instead. The export is kept (and intentionally a no-op) so existing
 * specs and any external callers keep compiling; it is NOT part of the public
 * runtime API.
 */
export function _resetWriteDeadlinesForTests(): void {
  // Intentionally empty — no module-level mutable tracker remains to reset.
}
