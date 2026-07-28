/**
 * Issue #512 × #511 — o subscriber do cache de contexto do turno entra no drain.
 *
 * O subscriber tem conexão ioredis PRÓPRIA: o ioredis proíbe outros comandos
 * num cliente inscrito, então o cliente compartilhado que `shutdownPools()`
 * encerra é OUTRO handle. Sem fechar este aqui, um processo drenado ficava com
 * um socket pub/sub aberto, o event loop nunca esvaziava, e o backstop
 * pós-drain disparava `maia_shutdown_forced_total{reason="handles_still_open"}`
 * em TODO deploy limpo — um shutdown que se dizia forçado sem nada de errado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/env.js', () => ({
  config: {
    REDIS_URL: 'redis://localhost:6379',
    FEATURE_TURN_CONTEXT_CACHE: true,
    TURN_CONTEXT_CACHE_TTL_MS: 60_000,
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  startTurnContextCacheInvalidationSubscriber,
  stopTurnContextCacheInvalidationSubscriber,
  _resetTurnContextSubscriberForTests,
  _setTurnContextSubscriberFactoryForTests,
  _subscribeTenantForTests,
} from '../../../src/agent/turn-context/cache.js';

beforeEach(() => {
  _resetTurnContextSubscriberForTests();
});

describe('stopTurnContextCacheInvalidationSubscriber', () => {
  it('encerra a conexão dedicada (senão o event loop não esvazia)', async () => {
    const quit = vi.fn(async () => undefined);
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
      quit,
    }));
    startTurnContextCacheInvalidationSubscriber();
    await _subscribeTenantForTests('acme');

    await stopTurnContextCacheInvalidationSubscriber();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('é no-op num processo que nunca construiu a conexão (flag off ou papel sem prompt)', async () => {
    // A conexão é preguiçosa: sem nenhum tenant cacheando, nada foi aberto.
    startTurnContextCacheInvalidationSubscriber();
    await expect(stopTurnContextCacheInvalidationSubscriber()).resolves.toBeUndefined();
  });

  it('é idempotente — o drain pode ser chamado duas vezes', async () => {
    const quit = vi.fn(async () => undefined);
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
      quit,
    }));
    startTurnContextCacheInvalidationSubscriber();
    await _subscribeTenantForTests('acme');

    await stopTurnContextCacheInvalidationSubscriber();
    await stopTurnContextCacheInvalidationSubscriber();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('DESABILITA antes de fechar: um subscribe correndo com o drain falha fechado', async () => {
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
      quit: async () => undefined,
    }));
    startTurnContextCacheInvalidationSubscriber();
    await _subscribeTenantForTests('acme');

    await stopTurnContextCacheInvalidationSubscriber();

    // Mesmo contrato fail-safe de um processo que nunca ligou o subscriber: o
    // cache recusa armazenar em vez de rodar sem invalidação.
    await expect(_subscribeTenantForTests('acme')).rejects.toThrow(/subscriber_not_started/);
  });

  it('não propaga erro de um quit que falha (a conexão já estava caindo)', async () => {
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
      quit: async () => {
        throw new Error('Connection is closed.');
      },
    }));
    startTurnContextCacheInvalidationSubscriber();
    await _subscribeTenantForTests('acme');

    await expect(stopTurnContextCacheInvalidationSubscriber()).resolves.toBeUndefined();
  });

  it('tolera um cliente sem quit (dublê de teste)', async () => {
    _setTurnContextSubscriberFactoryForTests(async () => ({
      on: () => undefined,
      connect: async () => undefined,
      subscribe: async () => undefined,
    }));
    startTurnContextCacheInvalidationSubscriber();
    await _subscribeTenantForTests('acme');

    await expect(stopTurnContextCacheInvalidationSubscriber()).resolves.toBeUndefined();
  });
});
