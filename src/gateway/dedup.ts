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
 * `repositories.ts`. Only the Redis layer was leaky — so the fix is local
 * to this module: prefix the Redis key with `tenant_id` resolved from the
 * AsyncLocalStorage tenant context, with NO fallback to a "default" or
 * empty namespace. A missing context throws `MissingTenantContextError`
 * (loud failure) — masking a missing-context bug with a shared key is
 * strictly worse than crashing.
 *
 * Key format: `dedup:msg:${tenant_id}:${whatsapp_id}`
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
import { getCurrentTenant } from '@/db/tenant-context.js';

function dedupKey(whatsapp_id: string): string {
  // `getCurrentTenant()` throws `MissingTenantContextError` when the caller
  // isn't wrapped in `runWithTenantContext` — see invariant block above.
  // We refuse to fall through to a shared key.
  const tenant_id = getCurrentTenant();
  return `dedup:msg:${tenant_id}:${whatsapp_id}`;
}

const TTL_SECONDS = 60 * 60 * 24;

export async function isDuplicate(whatsapp_id: string): Promise<boolean> {
  // Resolve the tenant-scoped key BEFORE any Redis/DB work — if there is
  // no active tenant context this throws and propagates to the caller's
  // try/catch (in baileys.ts, `baileys.handle_failed`), surfacing the bug
  // instead of silently sharing a dedup namespace across tenants.
  const key = dedupKey(whatsapp_id);
  if (isRedisConnected()) {
    const seen = await redis.exists(key);
    if (seen) return true;
  }
  const found = await mensagensRepo.findByWhatsappId(whatsapp_id);
  if (found) {
    if (isRedisConnected()) {
      await redis.set(key, '1', 'EX', TTL_SECONDS);
    }
    return true;
  }
  return false;
}

export async function markSeen(whatsapp_id: string): Promise<void> {
  const key = dedupKey(whatsapp_id);
  if (isRedisConnected()) {
    await redis.set(key, '1', 'EX', TTL_SECONDS);
  }
}
