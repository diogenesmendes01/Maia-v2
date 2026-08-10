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
 *  4. **Validade normalizada para ABSOLUTA antes da gravação** (revisão do
 *     owner da #541). Um `ttl_ms` que chega até a chave durável é o kill switch
 *     imortal: a chave ficava sem `PX` e cada réplica reinterpretava a validade
 *     contra o próprio boot. O TTL de verdade (`PTTL` no servidor) é provado em
 *     `tests/integration/llm-circuit-kill-switch-redis.spec.ts`, contra Redis
 *     real — um mock não tem TTL. Aqui prova-se a FORMA do comando e do
 *     payload, que é o que este arquivo consegue afirmar com honestidade.
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

/**
 * Trilha durável mockada: `circuit-audit.ts` puxa `@/db/client.js`, que abre um
 * pool de Postgres, e este spec cobre transporte (Redis), não persistência. A
 * escrita real é provada em `tests/integration/llm-circuit-audit-real-db.spec.ts`.
 */
vi.mock('@/lib/llm/circuit-audit.js', () => ({
  recordCircuitAudit: vi.fn(),
  drainCircuitAudits: vi.fn(async () => undefined),
  _internal: { pendingCount: () => 0 },
}));

vi.mock('@/lib/llm/model-resolver.js', () => ({
  invalidateModelCache: invalidateModelCacheMock,
}));

import {
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  handleLLMSettingsInvalidation,
  publishCircuitOverride,
} from '@/lib/llm/cache-invalidation.js';
import {
  DEFAULT_OVERRIDE_MS,
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  MAX_OVERRIDE_MS,
  applyCircuitOverride,
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
   * O defeito da revisão: com só `ttl_ms`, o `SET` saía SEM `PX` e a chave
   * guardava validade RELATIVA. A chave vivia para sempre e toda réplica que
   * reiniciasse recomputava `now + ttl_ms` — o kill switch ressuscitava a cada
   * boot, sem ninguém ter decidido isso.
   */
  it('`ttl_ms` é normalizado para `expires_at` absoluto e SEMPRE grava com PX', async () => {
    const now = 1_700_000_000_000;
    await publishCircuitOverride(
      { mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 },
      now,
    );

    const [, payload, px, ttl] = redisMock.set.mock.calls[0]!;
    expect(px, 'chave sem PX vive para sempre').toBe('PX');
    expect(ttl).toBe(60_000);

    const persisted = JSON.parse(payload as string) as Record<string, unknown>;
    expect(persisted.expires_at).toBe(now + 60_000);
    // Duas verdades sobre o mesmo instante é como uma delas fica errada; a
    // relativa é justamente a que ressuscita.
    expect(persisted.ttl_ms).toBeUndefined();
    // O canal recebe o MESMO payload normalizado: quem adota a chave e quem
    // ouve a mensagem têm que concordar sobre o instante de vencimento.
    expect(redisMock.publish).toHaveBeenCalledWith(LLM_CIRCUIT_OVERRIDE_CHANNEL, payload);
  });

  it('sem validade declarada, grava o default de 30min com PX', async () => {
    const now = 1_700_000_000_000;
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON }, now);
    const [, payload, px, ttl] = redisMock.set.mock.calls[0]!;
    expect(px).toBe('PX');
    expect(ttl).toBe(DEFAULT_OVERRIDE_MS);
    expect((JSON.parse(payload as string) as { expires_at: number }).expires_at).toBe(
      now + DEFAULT_OVERRIDE_MS,
    );
  });

  it('validade fora dos limites LANÇA e não grava nada', async () => {
    const now = 1_700_000_000_000;
    await expect(
      publishCircuitOverride(
        { mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: MAX_OVERRIDE_MS + 1 },
        now,
      ),
    ).rejects.toThrow(/teto/);
    await expect(
      publishCircuitOverride(
        { mode: 'off', actor: ACTOR, reason: REASON, expires_at: now - 1 },
        now,
      ),
    ).rejects.toThrow(/vencido/);
    // Validar ANTES de tocar no Redis: um arrendamento recusado não pode ficar
    // na chave esperando a próxima réplica adotá-lo.
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.publish).not.toHaveBeenCalled();
  });

  /**
   * Defesa em profundidade do mesmo defeito, do lado de quem LÊ: mesmo que uma
   * chave com validade relativa apareça (um `redis-cli SET` na mão, um payload
   * de uma versão antiga), adotá-la reiniciaria a contagem a cada boot.
   */
  it('adoção RECUSA payload persistido com validade relativa', () => {
    const now = 1_700_000_000_000;
    const relative = { mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 };

    expect(applyCircuitOverride(relative, now, 'adopted').applied).toBe(false);
    expect(effectiveMode(now)).toBe(modeInternal.baselineMode());

    // O mesmo payload pelo CANAL continua válido: ali a validade relativa é
    // resolvida na chegada e não sobrevive a nada.
    expect(applyCircuitOverride(relative, now, 'applied').applied).toBe(true);
    expect(effectiveMode(now)).toBe('off');
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
