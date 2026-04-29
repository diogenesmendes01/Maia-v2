import { redis, isRedisConnected } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';

const TTL_SECONDS = 3600;
const KEY_PREFIX = 'maia:vision:';

/**
 * Best-effort vision-result cache keyed by `tool:file_sha256`. Lets two
 * different pessoas / entidades reuse the same parse without paying the
 * Vision API cost twice. The dispatcher's idempotency layer (see
 * `governance/idempotency.ts`) keys on `(pessoa_id, entity_id, file_sha256)`,
 * which is too narrow to catch the cross-pessoa case.
 *
 * Cache misses (Redis down, deserialization error) are silently ignored —
 * the tool falls back to a fresh Vision call.
 */
export async function getCachedVision<T>(tool: string, file_sha256: string): Promise<T | null> {
  if (!isRedisConnected()) return null;
  try {
    const v = await redis.get(KEY_PREFIX + tool + ':' + file_sha256);
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
  if (!isRedisConnected()) return;
  try {
    await redis.setex(KEY_PREFIX + tool + ':' + file_sha256, TTL_SECONDS, JSON.stringify(value));
  } catch (err) {
    logger.warn({ err: (err as Error).message, tool }, 'vision_cache.write_failed');
  }
}
