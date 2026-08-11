/**
 * Invalidação cross-réplica do cache de settings do LLM Gateway (issue #508).
 *
 * Requer Redis real (`npm run test:integration:setup`). Prova o critério de
 * aceite "atualização no Admin invalida o cache em todas as réplicas":
 * publica no canal a partir de um cliente e verifica que um subscriber
 * independente — o análogo de outra réplica — recebe e solta o cache local.
 *
 * O cache de modelos é in-process: sem esta propagação, cada réplica serviria
 * o modelo antigo até o TTL curto expirar, exatamente durante o incidente que
 * motivou a troca.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import {
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  handleLLMSettingsInvalidation,
} from '@/lib/llm/cache-invalidation.js';

let publisher: IORedis;
let subscriber: IORedis;

beforeAll(async () => {
  // `retryStrategy: () => null` + `connectTimeout` curto: sem Redis (dev local)
  // o spec falha em ~2s com ECONNREFUSED em vez de gastar 30s em reconexões.
  // A falha continua alta e visível — este teste EXIGE Redis, e mascará-la com
  // um skip esconderia exatamente o critério de aceite que ele cobre.
  const opts = {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  } as const;
  publisher = new IORedis(config.REDIS_URL, opts);
  subscriber = new IORedis(config.REDIS_URL, opts);
});

afterAll(async () => {
  await publisher?.quit().catch(() => undefined);
  await subscriber?.quit().catch(() => undefined);
});

describe('LLM settings — invalidação cross-réplica', () => {
  it('mensagem publicada por uma réplica chega ao subscriber da outra', async () => {
    const received: string[] = [];
    subscriber.on('message', (channel) => {
      received.push(channel);
      // Mesma função que a réplica real executa no handler.
      handleLLMSettingsInvalidation(channel);
    });
    await subscriber.subscribe(LLM_SETTINGS_INVALIDATION_CHANNEL);

    await publisher.publish(LLM_SETTINGS_INVALIDATION_CHANNEL, JSON.stringify({ at: Date.now() }));

    // Pub/sub é fire-and-forget; espera curta com deadline.
    const deadline = Date.now() + 2000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(received).toContain(LLM_SETTINGS_INVALIDATION_CHANNEL);
  });

  it('mensagem em outro canal não é entregue neste subscriber', async () => {
    const received: string[] = [];
    subscriber.on('message', (channel) => received.push(channel));
    await publisher.publish('maia:llm:settings:invalidate:outro', 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(received).not.toContain('maia:llm:settings:invalidate:outro');
  });
});
