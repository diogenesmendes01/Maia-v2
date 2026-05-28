import { redis, isRedisConnected } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant } from '@/db/tenant-context.js';

const TTL_SECONDS = 3600;
const KEY_PREFIX = 'maia:vision:';

/**
 * Best-effort vision-result cache. Lets two different pessoas / entidades
 * reuse the same parse within the SAME tenant without paying the Vision API
 * cost twice. The dispatcher's idempotency layer (see
 * `governance/idempotency.ts`) keys on `(pessoa_id, entity_id, file_sha256)`,
 * which is too narrow to catch the cross-pessoa case within a tenant.
 *
 * TENANT-ISOLATION INVARIANT (issue #250, project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Before this fix the key was `maia:vision:${tool}:${sha256}` — a same-hash
 * file uploaded by tenant A and then by tenant B would serve B the *cached*
 * result that was computed for A. The current prompts (`BOLETO_PROMPT`,
 * `RECEIPT_PROMPT` in `src/lib/vision.ts`) are static per-tool, so the
 * semantic risk of seeing "tenant-A's prompt artifacts" is small — but the
 * compliance angle remains: a Vision parse served from another tenant's
 * cache leaves NO audit trail for tenant B's processing event.
 *
 * AFTER this fix:
 *   - Key is `maia:vision:${tenant_id}:${tool}:${sha256}`, where `tenant_id`
 *     is resolved from `getCurrentTenant()` (AsyncLocalStorage via
 *     `@/db/tenant-context`).
 *   - Missing tenant context throws `MissingTenantContextError` — loud
 *     failure, never a silent fall-through to a shared bucket. Rationale:
 *     a cache entry written under a wrong/empty namespace would be
 *     unrecoverable cross-tenant pollution; better to surface the misuse
 *     than mask it.
 *   - The old prefix is no longer reachable through this API; pre-existing
 *     entries age out via the existing 1h TTL (`TTL_SECONDS`). No explicit
 *     migration is required — the data is short-lived by construction.
 *
 * Cache misses (Redis down, deserialization error) remain silently ignored
 * — the tool falls back to a fresh Vision call.
 */
export async function getCachedVision<T>(tool: string, file_sha256: string): Promise<T | null> {
  // Resolve tenant BEFORE the Redis call — if there is no active tenant
  // context this throws `MissingTenantContextError`. We refuse to serve a
  // cached vision result without a tenant attribution.
  const tenant_id = getCurrentTenant();
  if (!isRedisConnected()) return null;
  try {
    const v = await redis.get(`${KEY_PREFIX}${tenant_id}:${tool}:${file_sha256}`);
    return v ? (JSON.parse(v) as T) : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, tool }, 'vision_cache.read_failed');
    return null;
  }
}

export async function setCachedVision(
  tool: string,
  file_sha256: string,
  value: unknown,
): Promise<void> {
  // Same invariant as getCachedVision — refuse to write without a tenant
  // attribution. A vision result written into the shared bucket would be
  // served to ANY tenant on subsequent reads.
  const tenant_id = getCurrentTenant();
  if (!isRedisConnected()) return;
  try {
    await redis.setex(
      `${KEY_PREFIX}${tenant_id}:${tool}:${file_sha256}`,
      TTL_SECONDS,
      JSON.stringify(value),
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, tool }, 'vision_cache.write_failed');
  }
}
