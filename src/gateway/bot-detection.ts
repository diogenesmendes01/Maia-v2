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
 * Key format: `maia:botdet:${tenant_id}:${agent_id}:${phone}`.
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
 * counter is short-lived by construction.
 */
import { redis, isRedisConnected } from '@/lib/redis.js';
import { pessoasRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

function botDetectionKey(phone: string): string {
  // `getCurrentTenant()` / `getCurrentAgent()` throw `MissingTenantContextError`
  // if the caller isn't wrapped in `runWithTenantContext` — see invariant block.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `maia:botdet:${tenant_id}:${agent_id}:${phone}`;
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
 */
export async function checkBotAndMaybeBlock(tel: string): Promise<boolean> {
  // Resolve the tenant-scoped key BEFORE the Redis-connected guard. We want
  // a missing-context bug to surface as a loud failure even when Redis is
  // down — otherwise a degraded-Redis run would silently mask the boundary
  // violation. The accessor throws synchronously, which is fine: the caller
  // already wraps `handleIncoming` in try/catch with `baileys.handle_failed`
  // logging.
  const key = botDetectionKey(tel);
  if (!isRedisConnected()) return false; // degraded: skip rather than fail-open
  let count: number;
  try {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'bot_detection.redis_failed');
    return false;
  }
  if (count <= THRESHOLD) return false;

  const pessoa = await pessoasRepo.findByPhone(tel);
  if (!pessoa) return true; // unknown number flooding → drop without action
  if (pessoa.status === 'bloqueada') return true;
  if (pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono') {
    // Never auto-block owners — log only.
    logger.warn({ pessoa_id: pessoa.id, count }, 'bot_detection.owner_threshold_exceeded');
    return false;
  }
  await pessoasRepo.updateStatus(pessoa.id, 'bloqueada');
  await audit({
    acao: 'auto_blocked_anomalous_volume',
    pessoa_id: pessoa.id,
    metadata: { count, window_seconds: WINDOW_SECONDS },
  });
  logger.warn({ pessoa_id: pessoa.id, count }, 'bot_detection.auto_blocked');
  return true;
}
