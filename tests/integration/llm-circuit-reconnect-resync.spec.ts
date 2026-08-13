/**
 * A lacuna de reconexão do pub/sub do kill switch, contra Redis REAL — gate 4
 * da #534.
 *
 * O defeito é invisível para um mock: ele mora no SOCKET. Pub/sub do Redis é
 * at-most-once e não tem replay; o ioredis reconecta sozinho e restaura as
 * inscrições, mas a mensagem publicada enquanto o socket estava morto está
 * perdida para sempre. O cenário do dono: o plantão vira o kill switch às 3h e
 * a réplica que estava desconectada naquele instante continua recusando
 * tráfego até o TTL natural do arrendamento — a alavanca de incidente falha
 * exatamente no cenário para o qual ela existe.
 *
 * Aqui a queda é DE VERDADE (`CLIENT KILL` no id da conexão do subscriber, a
 * partir de um cliente "operador" separado), a perda da mensagem é PROVADA
 * (`PUBSUB NUMSUB` em zero no instante do `PUBLISH`) e a convergência é
 * afirmada, não presumida (`llmSettingsSubscriberResyncCount()`).
 *
 * O caminho exercido é o de produção: `startLLMSettingsInvalidationSubscriber()`,
 * a mesma função que `src/index.ts:184` chama. Nada aqui monta subscriber
 * próprio — um teste que remontasse o wiring passaria com o wiring de produção
 * deletado.
 *
 * Gating e limpeza seguem `llm-circuit-kill-switch-redis.spec.ts`: sem Redis o
 * spec FALHA rápido (~2s, `ECONNREFUSED`) em vez de dar skip. Um skip aqui
 * esconderia o gate inteiro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import IORedis from 'ioredis';

/**
 * Este arquivo é sobre o TRANSPORTE (socket que morre, mensagem que se perde),
 * não sobre persistência. A trilha durável tem spec próprio
 * (`llm-circuit-audit-real-db.spec.ts`) e escrever nela aqui poluiria um banco
 * compartilhado.
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
  llmSettingsSubscriberResyncCount,
  publishCircuitOverride,
  startLLMSettingsInvalidationSubscriber,
} from '@/lib/llm/cache-invalidation.js';
import {
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
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

async function waitFor(pred: () => boolean, ms = 2500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

/**
 * Ids das conexões em modo pub/sub, vistos pelo SERVIDOR.
 *
 * O alvo é identificado por DIFERENÇA (antes × depois de subir o subscriber) em
 * vez de `CLIENT KILL TYPE pubsub`: matar todos derrubaria subscribers de
 * outros specs rodando contra o mesmo Redis, e um teste que quebra o vizinho
 * não é um teste, é um flake.
 */
async function pubsubClientIds(): Promise<Set<string>> {
  const raw = (await probe.call('client', 'list', 'type', 'pubsub')) as string;
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = /^id=(\d+)/.exec(line);
    if (m) ids.add(m[1]!);
  }
  return ids;
}

/** Sobe o subscriber de PRODUÇÃO e devolve o id da conexão dele no servidor. */
async function bootSubscriber(): Promise<string> {
  const before = await pubsubClientIds();
  startLLMSettingsInvalidationSubscriber();
  await llmSettingsSubscriberReady();

  let fresh: string[] = [];
  const deadline = Date.now() + 3000;
  while (fresh.length === 0 && Date.now() < deadline) {
    const after = await pubsubClientIds();
    fresh = [...after].filter((id) => !before.has(id));
    if (fresh.length === 0) await new Promise((r) => setTimeout(r, 20));
  }
  expect(fresh.length, 'o subscriber não apareceu como cliente pub/sub no Redis').toBeGreaterThan(
    0,
  );
  // UNICIDADE, não só presença — endurecimento pedido na rodada 2 da review da
  // #552. Este helper identifica o socket a matar por DIFERENÇA na lista de
  // clientes pub/sub do Redis, e o `CLIENT KILL` seguinte é destrutivo. Se
  // outro spec abrir um subscriber exatamente nesta janela, a diferença traz
  // dois ids e a versão anterior (`.find`) escolhia um qualquer — podendo matar
  // a conexão do vizinho e transformar este teste em sabotagem silenciosa de
  // outro. Duas conexões novas aqui não é ambiguidade tolerável: é sinal de que
  // a premissa do helper não vale nesta corrida, e falhar dizendo isso é mais
  // barato que um vermelho inexplicável em outro arquivo.
  expect(
    fresh.length,
    `apareceu mais de um subscriber pub/sub novo (${fresh.join(', ')}): ` +
      'não dá para saber qual é o desta corrida, e o CLIENT KILL seguinte é destrutivo',
  ).toBe(1);
  return fresh[0]!;
}

/**
 * Espera a releitura da reconexão TERMINAR e afirma que ela aconteceu.
 *
 * O deadline é menor que o `testTimeout` de propósito: um teste que estoura o
 * relógio do vitest só diz "travou". Falhando aqui, a mensagem diz QUAL
 * propriedade quebrou — que é o que um plantonista lê às 3h.
 */
async function awaitResync(before: number): Promise<void> {
  await waitFor(() => llmSettingsSubscriberResyncCount() > before);
  expect(
    llmSettingsSubscriberResyncCount(),
    'a réplica reconectou e NÃO releu o estado autoritativo: a mensagem perdida durante a queda nunca volta',
  ).toBeGreaterThan(before);
}

/** Quantos inscritos o Redis vê no canal do kill switch AGORA. */
async function subscriberCount(): Promise<number> {
  const res = (await probe.call('pubsub', 'numsub', LLM_CIRCUIT_OVERRIDE_CHANNEL)) as [
    string,
    string | number,
  ];
  return Number(res[1]);
}

async function resetReplica(): Promise<void> {
  _resetLLMSettingsSubscriberForTests();
  await new Promise((r) => setTimeout(r, 15));
  modeInternal.reset();
  await redis.del(LLM_CIRCUIT_OVERRIDE_KEY);
}

beforeAll(async () => {
  probe = new IORedis(config.REDIS_URL, probeOpts);
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

describe('kill switch — a réplica que RECONECTA no meio do incidente', () => {
  /**
   * O cenário inteiro, com socket morto de verdade:
   *
   *  1. réplica de pé e inscrita;
   *  2. o socket dela morre (`CLIENT KILL`);
   *  3. o plantão vira a chave — `SET` grava, `PUBLISH` não tem para quem ir
   *     (provado por `PUBSUB NUMSUB` = 0 no instante);
   *  4. o ioredis reconecta sozinho.
   *
   * Sem a releitura, a réplica sai daqui na postura do contrato e fica lá até o
   * arrendamento vencer — recusando (ou deixando de recusar) tráfego contra a
   * decisão do plantão. Com ela, converge sem esperar TTL nenhum.
   */
  it('adota o override que foi publicado enquanto o socket estava morto', async () => {
    const clientId = await bootSubscriber();
    expect(effectiveMode()).toBe(modeInternal.baselineMode());
    const resyncsBefore = llmSettingsSubscriberResyncCount();

    await probe.call('client', 'kill', 'id', clientId);
    // A mensagem tem que ser publicada com a inscrição comprovadamente fora.
    const gone = Date.now() + 2000;
    while ((await subscriberCount()) !== 0 && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await subscriberCount(), 'o socket não chegou a cair: a corrida não foi exercida').toBe(
      0,
    );

    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 600_000 });
    // Confirma que o PUBLISH foi para o vazio — é a perda de mensagem, o
    // defeito inteiro em uma asserção.
    expect(
      await subscriberCount(),
      'alguém estava inscrito na hora do PUBLISH: a mensagem NÃO se perdeu e o teste não prova nada',
    ).toBe(0);

    await awaitResync(resyncsBefore);

    await waitFor(() => effectiveMode() === 'off');
    expect(
      effectiveMode(),
      'réplica atravessou o incidente na postura do contrato: o kill switch não a alcançou',
    ).toBe('off');
  });

  /**
   * A direção contrária, que é a que dói em `enforce`: o `clear` do plantão
   * também é uma mensagem, e também se perde. Uma réplica que não a ouve
   * continua recusando tráfego DEPOIS de o disjuntor ter sido desligado.
   */
  it('limpa o override quando o `clear` acontece com o socket morto', async () => {
    const clientId = await bootSubscriber();
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 600_000 });
    await waitFor(() => effectiveMode() === 'off');
    expect(effectiveMode()).toBe('off');

    const resyncsBefore = llmSettingsSubscriberResyncCount();
    await probe.call('client', 'kill', 'id', clientId);
    const gone = Date.now() + 2000;
    while ((await subscriberCount()) !== 0 && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await subscriberCount()).toBe(0);

    await publishCircuitOverride({ clear: true, actor: ACTOR, reason: 'INC-4412 encerrado' });
    expect(await subscriberCount()).toBe(0);
    expect(await probe.exists(LLM_CIRCUIT_OVERRIDE_KEY)).toBe(0);

    await awaitResync(resyncsBefore);
    await waitFor(() => effectiveMode() === modeInternal.baselineMode());
    expect(
      effectiveMode(),
      'réplica seguiu com o override depois de o plantão ter desligado o disjuntor',
    ).toBe(modeInternal.baselineMode());
  });

  /**
   * A releitura reaproveita o que SOBROU do arrendamento — nunca o TTL
   * original. Um override adotado na reconexão que reiniciasse a contagem seria
   * o kill switch imortal por outra porta.
   */
  it('a adoção na reconexão herda o resto do arrendamento, não recomeça a contagem', async () => {
    const clientId = await bootSubscriber();
    const expires_at = Date.now() + 1500;
    await publishCircuitOverride({ mode: 'off', actor: ACTOR, reason: REASON, expires_at });
    await waitFor(() => effectiveMode() === 'off');

    const resyncsBefore = llmSettingsSubscriberResyncCount();
    await probe.call('client', 'kill', 'id', clientId);
    await awaitResync(resyncsBefore);

    // A releitura pegou a chave viva e manteve o MESMO instante de vencimento.
    expect(modeInternal.rawOverride()?.expires_at).toBe(expires_at);
    await waitFor(() => effectiveMode() !== 'off', 3000);
    expect(
      effectiveMode(),
      'o arrendamento foi reiniciado na reconexão: o kill switch não morre mais sozinho',
    ).toBe(modeInternal.baselineMode());
  });
});
