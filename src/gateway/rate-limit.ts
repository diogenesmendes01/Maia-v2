/**
 * Gateway rate-limit — true sliding-hour message rate limit per spec 03 §9.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #245, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Every Redis key emitted by this module is prefixed with `tenant_id` AND
 * `agent_id`, both pulled from the AsyncLocalStorage tenant context via
 * `getCurrentTenant()` / `getCurrentAgent()`. There is NO fallback to a
 * "default" or empty namespace — if a caller forgets to wrap the operation
 * in `runWithTenantContext`, the underlying accessor throws a
 * `MissingTenantContextError`. That is a LOUD failure by design (same
 * pattern as #232 procedural-memory mutators and #241 working-memory keys):
 * masking a missing-context bug with a shared fallback key would silently
 * collapse the tenant boundary, which is strictly worse than crashing.
 *
 * Concrete leak surface this fix closes (issue #245, MAJOR):
 *   The previous keys (`maia:ratelimit:hour:${pessoa_id}`,
 *   `maia:ratelimit:warned:${pessoa_id}`, `maia:ratelimit:silence:${pessoa_id}`)
 *   were keyed ONLY on `pessoa_id`. If the same `pessoa_id` is observed
 *   under two different tenants (B2B contact reused across Maias, fixed
 *   seeds in tests/staging, or any future ID-collision scenario), the
 *   sliding-hour counter, warned flag, and silence flag are SHARED — i.e.
 *   tenant-B saturating its own quota would push tenant-A's user into
 *   `silence` despite tenant-A having sent nothing. That is a
 *   cross-tenant DoS, exactly the kind of leak the project's founding
 *   principle forbids.
 *
 * Key formats (post-fix):
 *   maia:ratelimit:${enc(tenant_id)}:${enc(agent_id)}:hour:${enc(pessoa_id)}     (sorted-set)
 *   maia:ratelimit:${enc(tenant_id)}:${enc(agent_id)}:warned:${enc(pessoa_id)}
 *   maia:ratelimit:${enc(tenant_id)}:${enc(agent_id)}:silence:${enc(pessoa_id)}
 *
 * Aliasing-safe encoding (mirrors PR #257 `buildKey` pattern for
 * `_vision-cache.ts`): each segment is URI-encoded via `encodeURIComponent`
 * so the `:` segment delimiter and `%` quoting prefix can NEVER appear
 * unescaped inside a segment. Rationale: `tenants.id`/`agents.id` are text
 * columns and a free-form value containing `:` (e.g. an `acme:dev` slug)
 * would otherwise collide with `(tenant=acme, agent=dev:hour, …)` and
 * defeat the isolation invariant. `encodeURIComponent` keeps the encoding
 * reversible and segment-unambiguous (the only `%` in a key is a quoting
 * prefix we introduced).
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Any pre-existing Redis entries under the OLD prefixes are no longer
 * reachable through the public API and will age out via their existing
 * TTLs (1h for the sliding-window sorted set and the warned flag; 60s
 * for the silence flag). No explicit migration job is required — the
 * data is short-lived by construction and the worst-case effect is a
 * one-time hour where a flagged-then-silenced user gets a "fresh" quota
 * after deploy, which is strictly LESS restrictive (and only at deploy
 * time), not a safety regression. The encoding change has the same
 * property: previously-written keys (whose unencoded form differed only
 * when a segment contained `:` or `%`) simply expire on the existing TTL.
 *
 * Fail-closed surface (issue #245 review, P1 HIGH):
 *   Every Redis command this function issues is wrapped in try/catch,
 *   including the `get`/`set` calls on the overage path. A Redis failure
 *   during silence/warned probing or flag-write produces a fail-closed
 *   `silence` decision for non-owners (and `allow` for owners), never
 *   propagates out as an unhandled exception. The previous version
 *   wrapped only the sorted-set block, so a transient Redis blip on the
 *   overage path (latency spike, eviction, network jitter) would surface
 *   the error to the caller — strictly worse than the documented contract.
 *
 * OOM coverage (issue #309 — CONFIRMED, no change):
 *   A Redis OOM under `noeviction` (PR #294) surfaces as a `ReplyError` on
 *   any of the `zadd`/`zremrangebyscore`/`get`/`set` writes below. Both
 *   try/catch blocks already absorb it into the fail-closed `silence`
 *   (non-owner) / `allow` (owner) decision — exactly the OOM contract the
 *   runbook §4.5 documents for this caller. This module is therefore
 *   intentionally NOT modified by #309; it is the reference pattern the
 *   other callers were aligned to.
 */
import { redis, isRedisConnected } from '@/lib/redis.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import type { Pessoa } from '@/db/schema.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

const KEY_PREFIX = 'maia:ratelimit:';

/**
 * Build a tenant+agent-scoped Redis key. Each segment is URI-encoded so the
 * `:` delimiter is unambiguous: a tenant slug like `acme:dev` becomes
 * `acme%3Adev`, which can never collide with a tuple where the tenant is
 * `acme` and the agent starts with `dev:`. Mirrors the `buildKey` pattern
 * adopted by PR #257 (`src/tools/_vision-cache.ts`).
 *
 * `flavor` is one of `hour`, `warned`, `silence` and is a fixed code-path
 * constant (never user-controlled), so it is intentionally NOT encoded —
 * if it ever becomes dynamic, encode it too.
 */
function buildKey(
  tenant_id: string,
  agent_id: string,
  flavor: 'hour' | 'warned' | 'silence',
  pessoa_id: string,
): string {
  return (
    KEY_PREFIX +
    encodeURIComponent(tenant_id) +
    ':' +
    encodeURIComponent(agent_id) +
    ':' +
    flavor +
    ':' +
    encodeURIComponent(pessoa_id)
  );
}

const HOUR_MS = 3600 * 1000;
const HOUR_SECONDS = 3600;
const SILENCE_SECONDS = 60;

export type RateLimitDecision =
  | { kind: 'allow' }
  | { kind: 'warn'; count: number; threshold: number }
  | { kind: 'silence' };

/**
 * True sliding-hour message rate limit per spec 03 §9. Uses a Redis sorted
 * set keyed on `now_ms`: each call ZADDs the current timestamp, prunes
 * entries older than `now - 1h`, then reads ZCARD. Owners (dono/co_dono)
 * are exempt but still tracked so a runaway loop on the owner's number is
 * visible. Redis-down → fail-open for owners, fail-closed for everyone else.
 *
 * The previous implementation used INCR + EXPIRE-on-creation, which is a
 * fixed window: a non-owner could send 30 msgs at 10:59 and another 30 at
 * 11:00 and never trigger the limit. The sorted-set approach counts only
 * events inside the trailing 60 minutes regardless of when the key was born.
 *
 * Tenant context (issue #245): `getCurrentTenant()` / `getCurrentAgent()`
 * throw `MissingTenantContextError` if invoked outside a
 * `runWithTenantContext` boundary — see the invariant docblock at the top
 * of this file. The throw resolves BEFORE the `isRedisConnected()` check,
 * so a missing-context bug surfaces even when Redis is down (i.e. we never
 * silently allow or silence a request without a tenant scope).
 */
export async function checkRateLimit(pessoa: Pessoa): Promise<RateLimitDecision> {
  // Resolve tenant context FIRST — fail-loud on missing context regardless
  // of Redis state, matching the inviolable-isolation invariant. We don't
  // wrap this in try/catch because `MissingTenantContextError` is a
  // programming error (caller forgot to wrap in `runWithTenantContext`),
  // not a runtime exception to absorb.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const isOwner = pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono';
  if (!isRedisConnected()) {
    if (isOwner) return { kind: 'allow' };
    logger.warn(
      { pessoa_id: pessoa.id, tenant_id, agent_id },
      'rate_limit.redis_down_fail_closed',
    );
    return { kind: 'silence' };
  }

  const threshold = config.RATE_LIMIT_MSGS_PER_HOUR;
  const now = Date.now();
  const cutoff = now - HOUR_MS;
  const countKey = buildKey(tenant_id, agent_id, 'hour', pessoa.id);
  const silenceKey = buildKey(tenant_id, agent_id, 'silence', pessoa.id);
  const warnedKey = buildKey(tenant_id, agent_id, 'warned', pessoa.id);

  let count: number;
  try {
    await redis.zremrangebyscore(countKey, 0, cutoff);
    // Score is `now`; member is `now-<rand>` to avoid collapsing concurrent
    // calls at the same millisecond onto a single set entry.
    await redis.zadd(countKey, now, `${now}-${Math.random().toString(36).slice(2, 10)}`);
    await redis.expire(countKey, HOUR_SECONDS);
    count = await redis.zcard(countKey);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pessoa_id: pessoa.id, tenant_id, agent_id },
      'rate_limit.zset_failed',
    );
    return isOwner ? { kind: 'allow' } : { kind: 'silence' };
  }

  if (isOwner || count <= threshold) return { kind: 'allow' };

  // Overage path. Every Redis op below MUST be inside the try/catch so a
  // transient failure (latency spike, eviction, network blip) produces a
  // fail-closed decision rather than propagating to the caller — same
  // contract as the zset block above. Pre-fix, these get/set calls were
  // outside the guard and a Redis failure here would surface as an
  // unhandled rejection at the dispatcher (issue #245 review, P1 HIGH).
  try {
    const silenced = await redis.get(silenceKey);
    if (silenced) return { kind: 'silence' };

    const warned = await redis.get(warnedKey);
    if (warned) {
      // Warning record exists but silence expired — re-arm silence without
      // sending another reply.
      await redis.set(silenceKey, '1', 'EX', SILENCE_SECONDS);
      return { kind: 'silence' };
    }

    // First overage in this sliding hour — emit one polite reply, silence 60s.
    await redis.set(warnedKey, '1', 'EX', HOUR_SECONDS);
    await redis.set(silenceKey, '1', 'EX', SILENCE_SECONDS);
    return { kind: 'warn', count, threshold };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, pessoa_id: pessoa.id, tenant_id, agent_id },
      'rate_limit.overage_failed',
    );
    // Non-owner already failed the count threshold — fail-closed to silence.
    // (Owners short-circuited above on the `isOwner || count <= threshold`
    // check, so this branch is non-owner by construction.)
    return { kind: 'silence' };
  }
}

export const POLITE_RATE_LIMIT_REPLY =
  'Você passou de {N} mensagens nessa última hora. Vou pausar por uns minutinhos para não te atropelar.';

export function formatPoliteReply(threshold: number): string {
  return POLITE_RATE_LIMIT_REPLY.replace('{N}', String(threshold));
}
