/**
 * O transporte do kill switch: canal de pub/sub + chave durável.
 *
 * A postura em si é testada em `llm-circuit-mode.spec.ts`. Este arquivo cobre
 * só o que fica entre o `redis-cli` do operador e a memória da réplica, que é
 * onde um kill switch costuma falhar de verdade:
 *
 *  1. **Roteamento por canal.** O override anda no MESMO subscriber ioredis do
 *     cache de settings (a conexão já existe e já é fechada no drain da #512).
 *     Uma mensagem no canal errado não pode invalidar o cache de modelo, e uma
 *     invalidação de settings não pode mexer na postura do disjuntor.
 *  2. **Ordem de escrita.** A chave durável é gravada ANTES do `PUBLISH`: uma
 *     réplica que sobe entre as duas operações perderia a mensagem e não
 *     acharia a chave. Invertendo, a pior janela é uma réplica adotar a postura
 *     um instante antes das outras — a direção segura.
 *  3. **`clear` apaga a chave**, senão o override voltaria do túmulo no próximo
 *     boot de uma réplica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisMock, invalidateModelCacheMock } = vi.hoisted(() => ({
  redisMock: {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    publish: vi.fn(async () => 1),
  },
  invalidateModelCacheMock: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: vi.fn(function (this: unknown) {
    return { on: vi.fn(), connect: vi.fn(async () => undefined), subscribe: vi.fn(), quit: vi.fn() };
  }),
}));

vi.mock('@/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('@/lib/llm/model-resolver.js', () => ({
  invalidateModelCache: invalidateModelCacheMock,
}));

import {
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  handleLLMSettingsInvalidation,
  publishCircuitOverride,
} from '@/lib/llm/cache-invalidation.js';
import {
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  effectiveMode,
  _internal as modeInternal,
} from '@/lib/llm/circuit-mode.js';

const ACTOR = 'sre:diogenes';
const REASON = 'INC-4412';

beforeEach(() => {
  modeInternal.reset();
  redisMock.set.mockClear();
  redisMock.del.mockClear();
  redisMock.publish.mockClear();
  invalidateModelCacheMock.mockClear();
});

describe('canal do kill switch — roteamento', () => {
  it('mensagem no canal do disjuntor muda a postura e NÃO invalida o cache de modelo', () => {
    handleLLMSettingsInvalidation(
      LLM_CIRCUIT_OVERRIDE_CHANNEL,
      JSON.stringify({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }),
    );
    expect(effectiveMode()).toBe('off');
    expect(invalidateModelCacheMock).not.toHaveBeenCalled();
  });

  it('mensagem no canal de settings invalida o cache e NÃO mexe na postura', () => {
    const before = effectiveMode();
    handleLLMSettingsInvalidation(LLM_SETTINGS_INVALIDATION_CHANNEL, '{}');
    expect(invalidateModelCacheMock).toHaveBeenCalledTimes(1);
    expect(effectiveMode()).toBe(before);
  });

  it('canal desconhecido não faz nada', () => {
    const before = effectiveMode();
    handleLLMSettingsInvalidation('maia:algum:outro:canal', '{"mode":"off"}');
    expect(invalidateModelCacheMock).not.toHaveBeenCalled();
    expect(effectiveMode()).toBe(before);
  });
});

describe('canal do kill switch — publicação', () => {
  it('grava a chave durável com TTL ANTES de publicar', async () => {
    const expires_at = Date.now() + 60_000;
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, expires_at });

    expect(redisMock.set).toHaveBeenCalledTimes(1);
    const [key, payload, px, ttl] = redisMock.set.mock.calls[0]!;
    expect(key).toBe(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(px).toBe('PX');
    expect(ttl as number).toBeGreaterThan(0);
    expect(ttl as number).toBeLessThanOrEqual(60_000);
    expect(JSON.parse(payload as string)).toMatchObject({ mode: 'off', actor: ACTOR });

    expect(redisMock.publish).toHaveBeenCalledWith(LLM_CIRCUIT_OVERRIDE_CHANNEL, payload);
    // A ordem é o ponto: réplica que sobe entre as duas operações precisa achar
    // a chave, e não perder a mensagem sem ter onde consultar.
    expect(redisMock.set.mock.invocationCallOrder[0]!).toBeLessThan(
      redisMock.publish.mock.invocationCallOrder[0]!,
    );
  });

  it('`clear` APAGA a chave durável, senão o override ressuscita no próximo boot', async () => {
    await publishCircuitOverride({ clear: true, actor: ACTOR, reason: 'encerrado' });
    expect(redisMock.del).toHaveBeenCalledWith(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.publish).toHaveBeenCalledTimes(1);
  });

  /**
   * Diferente da invalidação de settings, que é best-effort: quem virou o kill
   * switch precisa saber que ele NÃO virou. Um "ok" mentiroso durante incidente
   * é pior que um erro.
   */
  it('falha de Redis é PROPAGADA, não engolida', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('READONLY'));
    await expect(
      publishCircuitOverride({
        mode: 'off',
        actor: ACTOR,
        reason: REASON,
        expires_at: Date.now() + 60_000,
      }),
    ).rejects.toThrow('READONLY');
  });
});
