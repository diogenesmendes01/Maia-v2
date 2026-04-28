import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
});

let connected = false;
redis.on('ready', () => {
  connected = true;
  logger.info('redis.ready');
});
redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'redis.error');
});
redis.on('end', () => {
  connected = false;
  logger.warn('redis.end');
});

export function isRedisConnected(): boolean {
  return connected;
}

export async function ensureRedisConnect(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connecting') return;
  try {
    await redis.connect();
  } catch (err) {
    logger.warn({ err }, 'redis.connect_failed');
  }
}
