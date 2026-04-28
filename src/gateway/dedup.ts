import { redis, isRedisConnected } from '@/lib/redis.js';
import { mensagensRepo } from '@/db/repositories.js';

const REDIS_KEY = (id: string) => `dedup:msg:${id}`;
const TTL_SECONDS = 60 * 60 * 24;

export async function isDuplicate(whatsapp_id: string): Promise<boolean> {
  if (isRedisConnected()) {
    const seen = await redis.exists(REDIS_KEY(whatsapp_id));
    if (seen) return true;
  }
  const found = await mensagensRepo.findByWhatsappId(whatsapp_id);
  if (found) {
    if (isRedisConnected()) {
      await redis.set(REDIS_KEY(whatsapp_id), '1', 'EX', TTL_SECONDS);
    }
    return true;
  }
  return false;
}

export async function markSeen(whatsapp_id: string): Promise<void> {
  if (isRedisConnected()) {
    await redis.set(REDIS_KEY(whatsapp_id), '1', 'EX', TTL_SECONDS);
  }
}
