/**
 * Gateway dedup — short-lived "message already seen" cache backed by Redis,
 * with a DB-backed fallback through `mensagensRepo.findByWhatsappId`.
 *
 * TENANT-ISOLATION INVARIANT (issue #247, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Before this fix the Redis dedup key was `dedup:msg:${id}` — message id
 * ONLY, no tenant namespace. WhatsApp `whatsapp_id` values are not
 * guaranteed unique across tenants (different sessions can — rarely —
 * collide, or be predicted by an attacker). The unscoped key caused three
 * concrete failure modes flagged by the Codex revalidation pass on PR #241:
 *
 *   1. COLLISION-DROP: if two tenants ever share a `whatsapp_id` (e.g. an
 *      external system generates ids), tenant B's legitimate inbound is
 *      silently swallowed because tenant A has already cached the id.
 *   2. POISONING: an attacker who predicts a target tenant's `whatsapp_id`
 *      can pre-cache it under their own tenant, blocking the real message.
 *   3. INFORMATION DISCLOSURE: in any scenario where the dedup key surfaces
 *      in logs/metrics, a foreign tenant's message id leaks across the
 *      tenant boundary.
 *
 * The DB-backed fallback (`mensagensRepo.findByWhatsappId`) was ALREADY
 * tenant+agent-scoped via `getCurrentTenant()` / `getCurrentAgent()` in
 * `repositories.ts:467-482`. The Redis layer NOW MIRRORS that scoping —
 * `(tenant_id, agent_id, whatsapp_id)` — so the cache cannot diverge from
 * the source-of-truth lookup (e.g. cache hit for tenant-A/agent-X cannot
 * shadow a legitimate inbound to tenant-A/agent-Y on the same `whatsapp_id`).
 *
 * Key format (post-fix): `dedup:msg:${enc(tenant_id)}:${enc(agent_id)}:${enc(whatsapp_id)}`
 *
 * Aliasing-safe encoding (mirrors PR #257 `buildKey` pattern for
 * `_vision-cache.ts` and PR #258 for `rate-limit.ts`): each segment is
 * URI-encoded via `encodeURIComponent` so the `:` segment delimiter and
 * `%` quoting prefix can NEVER appear unescaped inside a segment.
 * Rationale: a tenant slug like `acme:dev` would otherwise collide with
 * `(tenant=acme, agent=dev:…)` and defeat the isolation invariant. The
 * encoding makes the segment boundary unambiguous and the only `%` in a
 * resulting key is a quoting prefix we introduced.
 *
 * Fail-closed validation (Codex review on PR #253, CRITICAL):
 *   `getCurrentTenant()` / `getCurrentAgent()` on main do NOT yet reject
 *   whitespace-only or empty strings (see #283 / `tenant-context.ts`
 *   whitespace fix on a separate unmerged branch). A corrupted ALS context
 *   (`{ tenant_id: '', agent_id: ' ' }`) would otherwise stringify into a
 *   shared `dedup:msg:::${wid}` or `dedup:msg:%20:%20:${wid}` namespace
 *   and reintroduce the cross-tenant collision the original fix closed.
 *   `assertSegment()` below rejects locally and throws
 *   `MissingTenantContextError` — defense-in-depth so this module is
 *   correct even when ALS validation is weaker upstream.
 *
 * Same-tenant race (Codex review on PR #253, MEDIUM):
 *   The previous version used `EXISTS` + `SET` as two round-trips. Two
 *   concurrent messages with the same `(tenant, agent, wid)` could both
 *   pass `EXISTS` before either reached `SET`, so both got processed.
 *   The new version uses `SET key 1 EX TTL NX` (mirrors the pattern in
 *   `src/scheduling/backpressure.ts:38` and `src/workers/dlq-monitor.ts:47`).
 *   The first writer wins atomically; subsequent reads observe the cached
 *   "1" via `EXISTS`. The DB fallback only fires on the writer's path,
 *   so the loser of the race correctly observes "already seen" and skips
 *   the duplicate processing.
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Pre-existing entries under the OLD `dedup:msg:${whatsapp_id}` prefix are
 * unreachable through the public API and will age out via the existing
 * 24h TTL. No migration job is required — the data is short-lived by
 * construction and the DB fallback (`findByWhatsappId`) still catches any
 * actual duplicate that races the cache miss.
 */
import { redis, isRedisConnected } from '@/lib/redis.js';
import { mensagensRepo } from '@/db/repositories.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

const KEY_PREFIX = 'dedup:msg:';
const TTL_SECONDS = 60 * 60 * 24;

/**
 * Local fail-closed guard for TENANT CONTEXT segments (tenant_id /
 * agent_id). `getCurrentTenant()` / `getCurrentAgent()` on `main` do not
 * yet enforce non-empty / non-whitespace — the whitespace fix in
 * `tenant-context.ts` lives on the unmerged #283 branch.
 *
 * Without this guard a corrupted ALS context — e.g.
 *   `{ tenant_id: '', agent_id: ' ' }` or
 *   `{ tenant_id: '  ', agent_id: 'agent-x' }`
 * would silently stringify into a shared namespace
 *   `dedup:msg:::${wid}` or `dedup:msg:%20:%20:${wid}`
 * and let two tenants with corrupted contexts collide on the SAME key,
 * reintroducing the cross-tenant collision the rest of this module
 * exists to prevent.
 *
 * Rule: must be string, `trim().length > 0`, AND no surrounding
 * whitespace (so `' acme '` is rejected — caller is expected to
 * normalise at the ingress boundary, not in this hot path).
 *
 * We re-raise as `MissingTenantContextError` (with augmented message,
 * since the no-arg constructor is the only signature available pre-#283)
 * because the caller's dispatch logic in `baileys.ts` already treats this
 * error class as a fatal context-missing failure → fail-closed semantics
 * are unified.
 */
function assertTenantSegment(
  value: unknown,
  name: 'tenant_id' | 'agent_id',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    const err = new MissingTenantContextError();
    err.message = `${err.message} (dedup: ${name} is empty, whitespace-only, or has surrounding whitespace)`;
    throw err;
  }
}

/**
 * Guard for the `whatsapp_id` segment. This is an EXTERNAL input (not a
 * tenant-context value) so an invalid value is a different failure mode
 * than a missing tenant context — we throw a plain TypeError to surface
 * the bug at the caller (`baileys.ts:291` already filters falsy ids, so
 * reaching this guard means a regression upstream).
 *
 * Rationale: collapsing this into `MissingTenantContextError` would
 * confuse error dashboards that key off `.code === 'MISSING_TENANT_CONTEXT'`.
 */
function assertWhatsappId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(
      'dedup: whatsapp_id must be a non-empty string with no surrounding whitespace',
    );
  }
}

/**
 * Build the tenant+agent+wid-scoped Redis key. Every segment is
 * `encodeURIComponent`-encoded so the `:` delimiter is unambiguous — a
 * tenant slug containing `:` (e.g. `acme:dev`) cannot collide with a
 * tuple where the colon is part of `agent_id` or `whatsapp_id`. See the
 * module-level comment "Aliasing-safe encoding" for rationale.
 *
 * `whatsapp_id` is also encoded: it's an external-system value and we
 * cannot assume it never contains `:` or `%`.
 */
function buildKey(
  tenant_id: string,
  agent_id: string,
  whatsapp_id: string,
): string {
  assertTenantSegment(tenant_id, 'tenant_id');
  assertTenantSegment(agent_id, 'agent_id');
  assertWhatsappId(whatsapp_id);
  return (
    KEY_PREFIX +
    encodeURIComponent(tenant_id) +
    ':' +
    encodeURIComponent(agent_id) +
    ':' +
    encodeURIComponent(whatsapp_id)
  );
}

/**
 * Resolve the tenant+agent context AND validate. Throws
 * `MissingTenantContextError` if the ALS context is missing OR carries
 * an empty/whitespace-only id — see `assertTenantSegment` above for why
 * this is defense-in-depth on top of `getCurrentTenant`/`getCurrentAgent`.
 */
function dedupKey(whatsapp_id: string): string {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return buildKey(tenant_id, agent_id, whatsapp_id);
}

/**
 * Returns true iff this `whatsapp_id` has already been seen for the
 * current (tenant, agent) tuple.
 *
 * Resolution order (matters for the fail-closed contract):
 *   1. `dedupKey()` first — if the ALS context is missing or corrupted,
 *      throw IMMEDIATELY before any Redis or DB work. Strictly worse to
 *      fall through to a shared namespace than to crash.
 *   2. `isRedisConnected()` short-circuit: when Redis is down we skip
 *      EXISTS and go straight to the DB fallback. The DB fallback is
 *      already tenant+agent-scoped via `findByWhatsappId` (see
 *      repositories.ts:467-482).
 *   3. Backfill on DB hit: when Redis is up AND the DB confirms a
 *      duplicate, write the cache entry so future EXISTS calls
 *      short-circuit. The backfill uses `SET … EX … NX` to match the
 *      atomic-marker contract of `markSeen` — two concurrent
 *      `isDuplicate` calls racing on the same DB hit do not both pay the
 *      cost of writing.
 */
export async function isDuplicate(whatsapp_id: string): Promise<boolean> {
  // Step 1: resolve+validate the tenant-scoped key BEFORE touching Redis
  // or the DB. A missing/corrupted ALS context propagates to the caller
  // (in baileys.ts the dispatcher catches and emits `baileys.handle_failed`).
  const key = dedupKey(whatsapp_id);

  // Step 2: Redis-fast-path. If connected and key already cached, return
  // true without paying the DB round-trip. If disconnected, skip directly
  // to the DB fallback — fail-closed by relying on the source-of-truth
  // tenant-scoped query rather than answering "not duplicate" optimistically.
  if (isRedisConnected()) {
    const seen = await redis.exists(key);
    if (seen) return true;
  }

  // Step 3: DB fallback. `findByWhatsappId` is tenant+agent-scoped via
  // `getCurrentTenant`/`getCurrentAgent`, so a foreign-tenant row cannot
  // satisfy this lookup. If we find a row, the message was processed
  // previously — backfill the cache (if Redis is up) so we don't keep
  // paying the DB cost.
  const found = await mensagensRepo.findByWhatsappId(whatsapp_id);
  if (found) {
    if (isRedisConnected()) {
      // SET NX EX: only write if absent. Two concurrent `isDuplicate`
      // callers racing on the same DB hit will both attempt this; only
      // the first wins, the second is a cheap no-op.
      await redis.set(key, '1', 'EX', TTL_SECONDS, 'NX');
    }
    return true;
  }

  return false;
}

/**
 * Atomically marks `whatsapp_id` as seen for the current (tenant, agent).
 *
 * Race semantics (Codex review on PR #253, MEDIUM finding):
 *   We use `SET key 1 EX TTL NX` (atomic check-and-set). When two inbound
 *   messages with the same `(tenant, agent, wid)` arrive concurrently:
 *     - The FIRST `markSeen` writes the key and returns "OK".
 *     - The SECOND `markSeen` finds the key already set and returns null
 *       (no-op). The caller does NOT distinguish — both are best-effort
 *       markers and the subsequent `isDuplicate` for either message
 *       observes the cached "1".
 *   This pattern is also used in `src/scheduling/backpressure.ts:38` and
 *   `src/workers/dlq-monitor.ts:47`.
 *
 * Redis-down branch: when Redis is disconnected we are a no-op. The
 * caller's next `isDuplicate` will fall through to the DB fallback (which
 * is the source of truth and is tenant+agent-scoped), so we do not
 * silently lose the dedup contract — we just defer it to the slower path.
 */
export async function markSeen(whatsapp_id: string): Promise<void> {
  const key = dedupKey(whatsapp_id);
  if (isRedisConnected()) {
    await redis.set(key, '1', 'EX', TTL_SECONDS, 'NX');
  }
}
