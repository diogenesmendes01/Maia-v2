/**
 * Bot detection — sliding 60-second flood counter that auto-blocks a pessoa
 * whose inbound rate exceeds THRESHOLD msgs/min (spec 05 §11.4).
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #246, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * The Redis counter key is prefixed with `tenant_id` AND `agent_id`, both
 * pulled from the AsyncLocalStorage tenant context via `getCurrentTenant()`
 * / `getCurrentAgent()`. There is NO fallback to a "default" or empty
 * namespace — if a caller forgets to wrap the operation in
 * `runWithTenantContext`, the underlying accessor throws a
 * `MissingTenantContextError`. That is a LOUD failure by design (consistent
 * with the memory-layer fixes in #232/#237/#241): the tenant boundary is
 * INVIOLABLE, so masking a missing-context bug with a shared fallback key is
 * strictly worse than crashing.
 *
 * Before this fix the key was `maia:botdet:${phone}` — no tenant/agent
 * namespace. Three concrete failure modes:
 *
 *   1. Cross-tenant FALSE POSITIVE: phone flooding tenant-A pumps the
 *      counter past THRESHOLD; tenant-B reads the SAME global key and
 *      treats a normal inbound from the same phone as a flood, blocking
 *      tenant-B's pessoa unfairly.
 *   2. Cross-tenant FALSE NEGATIVE: phone slowly probing tenant-A and
 *      tenant-B together stays under each tenant's per-tenant rate but
 *      blows past the threshold on a shared counter — or vice versa, a
 *      shared counter with a tenant-A "this is fine" history masks a
 *      tenant-B flood.
 *   3. BYPASS / cross-tenant DoS: an attacker drives the shared counter
 *      from a low-value tenant they control, then watches `bloqueada`
 *      status get applied across tenants — denying service on the
 *      primary tenant by acting in a secondary one.
 *
 * Key format: `maia:botdet:${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}`,
 * where each segment is URI-encoded via `encodeURIComponent` so the `:`
 * delimiter is unambiguous. Rationale (Codex review on PR #252, adopted
 * from PR #257 `_vision-cache.ts` `buildKey`):
 *   `tenants.id` and `agents.id` are `TEXT PRIMARY KEY` (free-form slug;
 *   see `migrations/007_p0_tenants_agents.sql`), so a tenant slug like
 *   `acme:dev` would otherwise collide with a `(tenant=acme,
 *   agent=dev:something, phone=...)` tuple — defeating the isolation
 *   invariant by *key aliasing*, not by missing context. `phone` is
 *   typically `+E164` and unlikely to contain `:`, but encoding it too
 *   keeps the rule "every segment is encoded" uniform and lets callers
 *   pass any string without re-deriving safety. `encodeURIComponent`
 *   makes the encoding reversible and segment-unambiguous (the only `%`
 *   in a key is a quoting prefix introduced by us).
 *
 * Note: `pessoasRepo.findByPhone` / `updateStatus` are themselves tenant-
 * scoped at the repo layer (tenant_id filter in SQL), so the "block the
 * pessoa" step was already isolated. The leak was specifically in the
 * Redis-side counter: cross-tenant inflation of the count caused the
 * THRESHOLD check to fire in tenants that hadn't independently observed
 * a flood. Prefixing the counter key closes that gap end-to-end.
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Pre-existing Redis entries under the OLD prefix (`maia:botdet:${phone}`)
 * are no longer reachable through the public API and will age out via the
 * existing 60-second TTL. No explicit migration job is required — the
 * counter is short-lived by construction. The encoding refinement has the
 * same property: previously-written keys (whose unencoded form differed
 * only when a segment contained `:` or `%`) simply expire on the 60s TTL.
 *
 * SCOPE NOTE (Codex review on PR #252, owner-confirmed):
 *   The Codex review flagged a CRITICAL systemic issue at
 *   `src/gateway/baileys.ts:232-234` (`messages.upsert`) and `:250-252`
 *   (`messages.update`): both wrap callbacks in
 *   `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, …)`
 *   — meaning that in production, every inbound message resolves to the
 *   same `(default, default)` tuple, collapsing every tenant's
 *   bot-detection counter back onto a shared bucket regardless of the
 *   per-key namespacing implemented here. This affects EVERY gateway-
 *   layer PR in the same family (#252, #253, #257, #258, #259, #264) and
 *   the fix (resolve `tenant_id`/`agent_id` from the inbound JID/channel
 *   before invoking the handler — or fail-closed if it can't be
 *   resolved) belongs in a coordinated upstream change to
 *   `src/gateway/baileys.ts`, NOT in any single per-layer fix.
 *
 *   That coordinated upstream change is tracked by **issue #290** (and
 *   in part #277 for `channel-resolver`-fail-loud). The owner has
 *   decided to merge each gateway-layer PR (this one included) AS-IS,
 *   then land #290 as a single coordinated PR that flips `baileys.ts`
 *   to resolve real `(tenant_id, agent_id)` from the inbound channel
 *   before invoking `handleIncoming`. The helper in this file is
 *   correct in isolation and ready to receive real `(tenant_id,
 *   agent_id)` tuples the moment that ingress resolution lands.
 *
 *   UNTIL #290 MERGES: in production every call to
 *   `checkBotAndMaybeBlock` resolves to the same `(default, default)`
 *   tuple, so this fix is PREPARATORY — it produces well-formed,
 *   correctly-encoded keys that DO route per-tenant in tests and in
 *   any environment where the caller passes a real tuple (admin tools,
 *   future SDK ingress, integration tests). The cross-tenant
 *   `bot-detection-cross-tenant.spec.ts` PROVES the helper isolates
 *   per (tenant_id, agent_id); the regression that keeps it from
 *   activating in prod is OWNED by #290.
 */
import {
  redis,
  isRedisConnected,
  isRedisOomError,
  recordRedisOomDegraded,
  recordRedisError,
} from '@/lib/redis.js';
import { pessoasRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { buildCacheKey } from '@/lib/cache-key.js';

const KEY_PREFIX = 'maia:botdet:';

/**
 * Build the tenant-scoped Redis key via the centralized `buildCacheKey`
 * helper (issue #287 consolidation). Each segment is URI-encoded so the `:`
 * delimiter is unambiguous (a tenant slug like `acme:dev` becomes
 * `acme%3Adev`) AND Redis glob metacharacters (`* ? [ ] !`) are neutralized
 * so a segment can never act as a wildcard in a `KEYS`/`SCAN` pattern.
 *
 * Key-compatibility note (#287): for every segment value that does NOT
 * contain `*` or `!`, `buildCacheKey` emits byte-identical keys to the
 * previous inline `encodeURIComponent` concat — no version bump needed.
 * Pathological segments containing `*`/`!` change shape, and any such
 * pre-existing entry simply ages out via the 60s TTL.
 *
 * Not exported — the public surface is `checkBotAndMaybeBlock`.
 */
function buildKey(tenant_id: string, agent_id: string, phone: string): string {
  return buildCacheKey(KEY_PREFIX, tenant_id, agent_id, phone);
}

const WINDOW_SECONDS = 60;
const THRESHOLD = 50; // > 50 msgs/min → auto-block per spec 05 §11.4

/**
 * Increment a sliding 60-second counter for the phone. If the count exceeds
 * THRESHOLD, set the corresponding pessoa to status='bloqueada' (when one
 * exists) and audit. Idempotent: subsequent triggers within the same window
 * are no-ops because the pessoa is already blocked.
 *
 * Returns true when the caller should drop the message (already-blocked or
 * just-blocked); false otherwise.
 *
 * MUST be called inside `runWithTenantContext` — otherwise throws
 * `MissingTenantContextError` (see invariant block at top of file).
 *
 * Logging: every `logger.warn` call below carries `{tenant_id, agent_id}`
 * so operators can attribute Redis failures, threshold crossings, and
 * auto-blocks to the correct Maia in a multi-tenant deployment. Without
 * this attribution the logs collapse onto a shared bucket and a
 * cross-tenant abuse pattern is invisible (Codex review on PR #252,
 * HIGH severity finding [2]). Mirrors the pattern adopted by PR #258
 * (`src/gateway/rate-limit.ts`).
 */
export async function checkBotAndMaybeBlock(tel: string): Promise<boolean> {
  // Resolve tenant/agent context ONCE at the top, BEFORE the Redis-connected
  // guard. Two reasons:
  //   1. A missing-context bug must surface as a loud failure even when
  //      Redis is down — otherwise a degraded-Redis run would silently
  //      mask the boundary violation. The accessor throws synchronously,
  //      which is fine: the caller already wraps `handleIncoming` in
  //      try/catch with `baileys.handle_failed` logging.
  //   2. We need the tuple available in every downstream log entry so
  //      `bot_detection.*` events can be attributed to the right tenant
  //      in a multi-tenant deployment (Codex review on PR #252,
  //      HIGH finding [2]). The `lib/logger.ts` pino instance does NOT
  //      automatically inject ALS context, so we pass it explicitly.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const key = buildKey(tenant_id, agent_id, tel);

  if (!isRedisConnected()) return false; // degraded: skip rather than fail-open
  let count: number;
  try {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  } catch (err) {
    // OOM handling (#309): the flood counter is a best-effort heuristic with
    // NO Postgres source of truth — on a Redis OOM we degrade to "don't block"
    // (return false), identical to the Redis-down skip above and the existing
    // generic-failure branch. Failing to increment the counter must never
    // block a legitimate user, and a raw `ReplyError` must never crash the
    // ingress path. We single OOM out for its own counter (capacity signal)
    // but the degraded behaviour is unchanged.
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('bot_detection.incr', { tenant_id, agent_id });
      return false;
    }
    // Non-OOM (conn reset, failover, READONLY, auth, …): still degrade to
    // "don't block" (best-effort heuristic, no Postgres source of truth), but
    // make the fault VISIBLE (#309 follow-up, PR #324 B2) — record a distinct
    // `redis_error_total{operation="bot_detection.incr"}` metric in addition
    // to the structured warn so a real Redis bug doesn't hide behind the
    // fail-open behaviour.
    recordRedisError('bot_detection.incr', { tenant_id, agent_id });
    logger.warn(
      { err: (err as Error).message, tenant_id, agent_id },
      'bot_detection.redis_failed',
    );
    return false;
  }
  if (count <= THRESHOLD) return false;

  const pessoa = await pessoasRepo.findByPhone(tel);
  if (!pessoa) return true; // unknown number flooding → drop without action
  if (pessoa.status === 'bloqueada') return true;
  if (pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono') {
    // Never auto-block owners — log only.
    logger.warn(
      { pessoa_id: pessoa.id, count, tenant_id, agent_id },
      'bot_detection.owner_threshold_exceeded',
    );
    return false;
  }
  await pessoasRepo.updateStatus(pessoa.id, 'bloqueada');
  await audit({
    acao: 'auto_blocked_anomalous_volume',
    pessoa_id: pessoa.id,
    metadata: { count, window_seconds: WINDOW_SECONDS },
  });
  logger.warn(
    { pessoa_id: pessoa.id, count, tenant_id, agent_id },
    'bot_detection.auto_blocked',
  );
  return true;
}
