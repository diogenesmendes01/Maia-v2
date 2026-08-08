/**
 * Kill switch do disjuntor de LLM contra Redis REAL (revisão do owner da #541).
 *
 * Os dois defeitos que esta suíte existe para travar são invisíveis com Redis
 * mockado — um mock não tem TTL de verdade e não tem ordem de comandos de
 * verdade, que é exatamente onde os dois moram:
 *
 *  1. **Chave imortal.** Quando o contrato trazia só `ttl_ms`, a chave durável
 *     era gravada SEM `PX` e guardava a validade RELATIVA. O override sumia da
 *     memória mas a chave ficava para sempre, e toda réplica que reiniciasse
 *     recomputava `now + ttl_ms` — o kill switch ressuscitava a cada boot,
 *     atravessando deploys, sem ninguém ter decidido isso. Aqui isso vira uma
 *     asserção sobre `PTTL` e sobre o que sobra da chave depois do vencimento.
 *  2. **Janela GET/SUBSCRIBE.** `subscribe()` é assíncrono: disparar e seguir
 *     para o `GET` na mesma volta do event loop põe o `GET` ANTES da inscrição
 *     estar ativa. Uma réplica que sobe junto com a virada da chave lia a
 *     chave antes do `SET`, perdia o `PUBLISH` por não estar inscrita ainda, e
 *     ficava na postura do contrato o incidente inteiro — justamente quando a
 *     alavanca importa. Aqui isso vira (a) uma prova de ordenação lida do
 *     `MONITOR` do próprio Redis e (b) uma corrida montada com a janela aberta
 *     de propósito.
 *
 * Gating e limpeza seguem `llm-settings-invalidation.spec.ts`: sem Redis o
 * spec FALHA rápido (~2s, `ECONNREFUSED`) em vez de dar skip. Um skip aqui
 * esconderia o critério de aceite inteiro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import IORedis from 'ioredis';

/**
 * Este arquivo é sobre o TRANSPORTE (Redis: PTTL real, ordem de comandos), não
 * sobre persistência. Desde que o override passou a auditar (revisão da PR
 * #541), cada virada aqui gravaria linha em `audit_log` — ruído num banco
 * compartilhado, e uma corrida com quem asserta sobre essas mesmas ações. A
 * escrita real é provada em `llm-circuit-audit-real-db.spec.ts`.
 */
vi.mock('@/lib/llm/circuit-audit.js', () => ({
  recordCircuitAudit: vi.fn(),
  drainCircuitAudits: vi.fn(async () => undefined),
  _internal: { pendingCount: () => 0 },
}));
import { config } from '@/config/env.js';
import { redis } from '@/lib/redis.js';
import {
  _resetLLMSettingsSubscriberForTests,
  llmSettingsSubscriberReady,
  publishCircuitOverride,
  startLLMSettingsInvalidationSubscriber,
} from '@/lib/llm/cache-invalidation.js';
import {
  DEFAULT_OVERRIDE_MS,
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  MAX_OVERRIDE_MS,
  effectiveMode,
  _internal as modeInternal,
} from '@/lib/llm/circuit-mode.js';

const ACTOR = 'sre:diogenes';
const REASON = 'INC-4412 disjuntor abrindo em brownout';

/** Cliente auxiliar (o "operador" com `redis-cli`), separado do pool do app. */
let probe: IORedis;

const probeOpts = {
  maxRetriesPerRequest: 1,
  connectTimeout: 1500,
  retryStrategy: () => null,
} as const;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

/** Zera a réplica: subscriber fechado, memória limpa, chave durável apagada. */
async function resetReplica(): Promise<void> {
  _resetLLMSettingsSubscriberForTests();
  // O `quit()` do subscriber é assíncrono: sem esta folga uma mensagem em voo
  // poderia pousar DEPOIS do `reset()` e poluir a tentativa seguinte.
  await new Promise((r) => setTimeout(r, 15));
  modeInternal.reset();
  await redis.del(LLM_CIRCUIT_OVERRIDE_KEY);
}

beforeAll(async () => {
  probe = new IORedis(config.REDIS_URL, probeOpts);
  // O pool compartilhado é `lazyConnect`. Conectar AQUI é o que torna honesta a
  // ordenação FIFO usada na corrida abaixo: com a conexão já de pé, um comando
  // enfileirado depois de outro volta depois dele, sem um handshake no meio.
  await redis.ping();
});

afterAll(async () => {
  await probe?.quit().catch(() => undefined);
  await redis.del(LLM_CIRCUIT_OVERRIDE_KEY).catch(() => undefined);
});

beforeEach(async () => {
  await resetReplica();
});

afterEach(async () => {
  await resetReplica();
});

// ---------------------------------------------------------------------------
// Defeito 1 — validade absoluta e chave que realmente morre
// ---------------------------------------------------------------------------

describe('kill switch — chave durável carrega TTL de verdade', () => {
  it('`ttl_ms` vira `expires_at` ABSOLUTO e a chave é gravada com PX', async () => {
    const before = Date.now();
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 });

    // A asserção que o mock não sabe fazer: a chave tem expiração NO SERVIDOR.
    const pttl = await probe.pttl(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(pttl, 'chave sem TTL: o kill switch viveria para sempre').toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    const raw = await probe.get(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as Record<string, unknown>;
    // Validade RELATIVA na chave durável é a própria ressurreição: cada réplica
    // que sobe recomeçaria a contagem. Só o absoluto sobrevive à persistência.
    expect(persisted.ttl_ms, '`ttl_ms` não pode ser persistido').toBeUndefined();
    expect(typeof persisted.expires_at).toBe('number');
    expect(persisted.expires_at as number).toBeGreaterThanOrEqual(before + 60_000);
    expect(persisted.expires_at as number).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('sem validade declarada, cai no default de 30min — e ainda com PX', async () => {
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON });
    const pttl = await probe.pttl(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(DEFAULT_OVERRIDE_MS);
  });

  it('`expires_at` absoluto é respeitado e o PX casa com ele', async () => {
    const expires_at = Date.now() + 45_000;
    await publishCircuitOverride({ mode: 'enforce', actor: ACTOR, reason: REASON, expires_at });
    const pttl = await probe.pttl(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(pttl).toBeGreaterThan(40_000);
    expect(pttl).toBeLessThanOrEqual(45_000);
    const persisted = JSON.parse((await probe.get(LLM_CIRCUIT_OVERRIDE_KEY))!) as {
      expires_at: number;
    };
    expect(persisted.expires_at).toBe(expires_at);
  });

  /**
   * O cenário do owner, inteiro: o arrendamento vence, uma réplica reinicia, e
   * o kill switch NÃO pode voltar do túmulo. Com o defeito a chave nem chegava
   * a ter TTL — ela sobrevivia ao processo, ao deploy e a quem esqueceu dela.
   */
  it('depois do vencimento, um restart NÃO ressuscita o override', async () => {
    startLLMSettingsInvalidationSubscriber();
    await llmSettingsSubscriberReady();
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 300 });
    expect(await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY)).toBe(1);
    await waitFor(() => effectiveMode() === 'off');
    expect(effectiveMode()).toBe('off');

    await new Promise((r) => setTimeout(r, 450));

    // 1. O Redis esqueceu a chave sozinho.
    expect(
      await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY),
      'chave sobreviveu ao arrendamento: o kill switch ressuscita a cada boot',
    ).toBe(0);

    // 2. Uma réplica NOVA (memória limpa, subscriber novo) sobe e adota nada.
    _resetLLMSettingsSubscriberForTests();
    modeInternal.reset();
    startLLMSettingsInvalidationSubscriber();
    await llmSettingsSubscriberReady();

    expect(effectiveMode(), 'réplica reiniciada voltou para o override vencido').toBe(
      modeInternal.baselineMode(),
    );
  });

  it('validade acima do teto é recusada ANTES de tocar no Redis', async () => {
    await expect(
      publishCircuitOverride({
        mode: 'off',
        actor: ACTOR,
        reason: REASON,
        ttl_ms: MAX_OVERRIDE_MS + 1,
      }),
    ).rejects.toThrow(/teto/);
    // Nada gravado: um arrendamento que o código recusa não pode ficar na
    // chave esperando a próxima réplica adotá-lo.
    expect(await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY)).toBe(0);
  });

  it('`clear` apaga a chave e a réplica que sobe depois fica no baseline', async () => {
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 });
    expect(await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY)).toBe(1);

    await publishCircuitOverride({ clear: true, actor: ACTOR, reason: 'INC-4412 encerrado' });
    expect(await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY)).toBe(0);

    modeInternal.reset();
    startLLMSettingsInvalidationSubscriber();
    await llmSettingsSubscriberReady();
    expect(effectiveMode()).toBe(modeInternal.baselineMode());
  });
});

// ---------------------------------------------------------------------------
// Defeito 2 — a janela GET/SUBSCRIBE
// ---------------------------------------------------------------------------

describe('kill switch — adoção depois do SUBSCRIBE confirmado', () => {
  /**
   * Prova de ordenação lida do PRÓPRIO Redis. `MONITOR` entrega os comandos na
   * ordem em que o servidor os processou — que é a ordem que importa, e a
   * única que um mock não consegue simular.
   */
  it('o `GET` da adoção chega ao Redis DEPOIS do `SUBSCRIBE`', async () => {
    const monitor = await probe.monitor();
    const seen: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) => {
      const cmd = String(args[0]).toLowerCase();
      if (cmd === 'subscribe' && args.includes(LLM_CIRCUIT_OVERRIDE_CHANNEL)) seen.push('subscribe');
      if (cmd === 'get' && args[1] === LLM_CIRCUIT_OVERRIDE_KEY) seen.push('get');
    });

    try {
      startLLMSettingsInvalidationSubscriber();
      await llmSettingsSubscriberReady();
      await waitFor(() => seen.includes('get') && seen.includes('subscribe'));

      expect(seen).toContain('subscribe');
      expect(seen).toContain('get');
      expect(
        seen.indexOf('get'),
        'o GET da adoção correu antes da inscrição estar ativa: a réplica perde o PUBLISH do incidente',
      ).toBeGreaterThan(seen.indexOf('subscribe'));
    } finally {
      await monitor.quit().catch(() => undefined);
    }
  });

  /**
   * A corrida do review, montada com a janela ABERTA de propósito.
   *
   * A janela do defeito exige duas coisas ao mesmo tempo: (a) o `GET` da
   * adoção já ter voltado vazio e (b) o `PUBLISH` acontecer antes da inscrição
   * ficar ativa. As duas são forçadas, não torcidas:
   *
   *  (a) `await redis.ping()` na MESMA conexão compartilhada que a adoção usa.
   *      ioredis mantém FIFO por conexão, então quando o PING volta, qualquer
   *      `GET` enfileirado na volta anterior do event loop já terminou.
   *  (b) `PUBSUB NUMSUB` medido DEPOIS do `PUBLISH` e ainda em zero. Inscrição
   *      só cresce nesta janela, então zero depois é zero durante: a mensagem
   *      comprovadamente não tinha para quem ir. Se a inscrição tiver ficado
   *      ativa no meio, a tentativa é descartada e o laço tenta de novo — em
   *      vez de afirmar algo que não valeu.
   *
   * Com o defeito, a réplica sai desta corrida no baseline e fica lá o
   * incidente inteiro. Com a correção, o `GET` só corre depois do ack e
   * encontra a chave que o `SET` já gravou.
   */
  it('réplica que sobe junto com a virada converge para o override, não para o baseline', async () => {
    let windowOpened = false;

    for (let attempt = 0; attempt < 25 && !windowOpened; attempt++) {
      await resetReplica();
      startLLMSettingsInvalidationSubscriber();

      await redis.ping();
      await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 });
      const numsub = (await probe.call('pubsub', 'numsub', LLM_CIRCUIT_OVERRIDE_CHANNEL)) as [
        string,
        string | number,
      ];
      windowOpened = Number(numsub[1]) === 0;
    }

    expect(
      windowOpened,
      'não foi possível abrir a janela GET/SUBSCRIBE — a corrida não foi exercida',
    ).toBe(true);

    await llmSettingsSubscriberReady();
    await waitFor(() => effectiveMode() === 'off');

    expect(
      effectiveMode(),
      'réplica ficou na postura do contrato durante o incidente: o kill switch não a alcançou',
    ).toBe('off');
  });
});
