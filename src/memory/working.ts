import { redis, isRedisConnected } from '@/lib/redis.js';

export async function pushMessage(conversa_id: string, role: 'user' | 'assistant', text: string): Promise<void> {
  if (!isRedisConnected()) return;
  const key = `working:conv:${conversa_id}:messages`;
  await redis.rpush(key, JSON.stringify({ role, text, ts: Date.now() }));
  await redis.ltrim(key, -20, -1);
  await redis.expire(key, 60 * 60 * 24);
}

export async function readRecent(conversa_id: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  if (!isRedisConnected()) return [];
  const key = `working:conv:${conversa_id}:messages`;
  const items = await redis.lrange(key, 0, -1);
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
