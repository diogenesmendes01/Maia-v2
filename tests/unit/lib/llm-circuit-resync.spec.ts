/**
 * Releitura na RECONEXÃO do subscriber — gate 4 da #534.
 *
 * A lacuna: pub/sub do Redis é at-most-once e não tem replay. O ioredis
 * reconecta o socket sozinho e restaura as inscrições, mas o que foi publicado
 * durante a queda se perdeu. Um operador vira o kill switch às 3h; a réplica
 * que estava desconectada naquele instante não recebe o `PUBLISH` e continua
 * recusando tráfego até o TTL natural do arrendamento — a alavanca de
 * incidente falha exatamente no cenário para o qual existe.
 *
 * ## Este arquivo exercita o CAMINHO DE PRODUÇÃO, não um espelho dele
 *
 * A armadilha conhecida deste repositório é o teste que remonta o call site com
 * harness próprio: ele passa mesmo quando o wiring de produção é deletado, e
 * não prova nada. Aqui quem cria a conexão, registra os handlers e encadeia a
 * releitura é `startLLMSettingsInvalidationSubscriber()`, a função que
 * `src/index.ts:184` chama. O que está falso é só o TRANSPORTE (o socket
 * ioredis e o pool do Redis), para que a queda possa ser provocada de forma
 * determinística: o `ready` é emitido no objeto que a produção construiu, pelos
 * handlers que a produção registrou. Apague o `sub.on('ready', …)` de
 * `cache-invalidation.ts` e todos os casos abaixo ficam vermelhos.
 *
 * O mesmo comportamento contra Redis REAL (socket morto de verdade por
 * `CLIENT KILL`, `PUBLISH` genuinamente perdido) está em
 * `tests/integration/llm-circuit-reconnect-resync.spec.ts`. Os dois são
 * necessários: aqui prova-se o que um Redis de verdade não deixa provocar sob
 * demanda (o `GET` falhando, a corrida com a mensagem em voo); lá prova-se que
 * a queda real produz o `ready` que dispara tudo isto.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (...args: unknown[]) => void;

/** Socket ioredis falso: guarda os handlers que a PRODUÇÃO registrou. */
interface FakeSub {
  handlers: Map<string, Handler[]>;
  emit(event: string, ...args: unknown[]): void;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

const { redisMock, invalidateModelCacheMock, incCounterMock, subs } = vi.hoisted(() => ({
  redisMock: {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    get: vi.fn(async (): Promise<string | null> => null),
    publish: vi.fn(async () => 1),
  },
  invalidateModelCacheMock: vi.fn(),
  incCounterMock: vi.fn(),
  subs: [] as FakeSub[],
}));

vi.mock('ioredis', () => ({
  default: vi.fn(function (this: unknown) {
    const handlers = new Map<string, Handler[]>();
    const sub: FakeSub = {
      handlers,
      emit(event, ...args) {
        for (const h of handlers.get(event) ?? []) h(...args);
      },
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return sub;
      }),
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => 2),
      quit: vi.fn(async () => 'OK'),
    };
    subs.push(sub);
    return sub;
  }),
}));

vi.mock('@/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('@/lib/metrics.js', () => ({
  incCounter: incCounterMock,
  observeHistogram: vi.fn(),
  setGaugeProvider: vi.fn(),
}));

/** Transporte, não persistência — a trilha real é provada em spec de banco. */
vi.mock('@/lib/llm/circuit-audit.js', () => ({
  recordCircuitAudit: vi.fn(),
  drainCircuitAudits: vi.fn(async () => undefined),
  _internal: { pendingCount: () => 0 },
}));

vi.mock('@/lib/llm/model-resolver.js', () => ({
  invalidateModelCache: invalidateModelCacheMock,
}));

import { recordCircuitAudit } from '@/lib/llm/circuit-audit.js';

import {
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  _resetLLMSettingsSubscriberForTests,
  handleLLMSettingsInvalidation,
  llmSettingsSubscriberReady,
  llmSettingsSubscriberResyncCount,
  startLLMSettingsInvalidationSubscriber,
} from '@/lib/llm/cache-invalidation.js';
import {
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  currentOverride,
  effectiveMode,
  _internal as modeInternal,
} from '@/lib/llm/circuit-mode.js';

const ACTOR = 'sre:diogenes';
const REASON = 'INC-4412 disjuntor abrindo em brownout';

function overridePayload(mode: string, ttlMs = 600_000): string {
  return JSON.stringify({ mode, actor: ACTOR, reason: REASON, expires_at: Date.now() + ttlMs });
}

function counterCalls(name: string): Array<Record<string, string>> {
  return incCounterMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, string>);
}

function resyncReasons(): string[] {
  return counterCalls('maia_llm_circuit_mode_overrides_total')
    .map((l) => l.reason ?? '')
    .filter((r) => r.startsWith('resync'));
}

/** Sobe o subscriber de PRODUÇÃO e consome o primeiro `ready` (o do boot). */
async function bootSubscriber(): Promise<FakeSub> {
  startLLMSettingsInvalidationSubscriber();
  const sub = subs.at(-1)!;
  sub.emit('ready');
  await llmSettingsSubscriberReady();
  return sub;
}

/** Provoca a volta do socket e espera a releitura TERMINAR (sem dormir às cegas). */
async function reconnect(sub: FakeSub): Promise<void> {
  const before = llmSettingsSubscriberResyncCount();
  sub.emit('close');
  sub.emit('reconnecting');
  sub.emit('ready');
  const deadline = Date.now() + 1000;
  while (llmSettingsSubscriberResyncCount() === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Espera uma condição com deadline curto — nunca dorme às cegas. */
async function waitUntil(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
}

/**
 * Responde à leitura mais RECENTE que estiver em voo.
 *
 * O mesmo código descreve os dois mundos, e é isso que faz dele um teste em vez
 * de um espelho da implementação:
 *
 *  - **em série** (com a `resyncChain`) só existe UMA leitura em voo por vez, e
 *    "a mais recente" é a única — a segunda releitura nem chegou a emitir a
 *    dela, porque a primeira ainda não terminou;
 *  - **concorrente** (sem a cadeia) as duas estão em voo juntas, e "a mais
 *    recente" é a leitura #2 — que passa a responder ANTES da #1, que é a
 *    inversão de ordem que se quer provocar.
 */
async function answerInFlight(
  inFlight: Array<(v: string | null) => void>,
  value: string,
): Promise<void> {
  await waitUntil(() => inFlight.length > 0);
  // Folga deliberada para uma segunda leitura CONCORRENTE aparecer, se o
  // desenho permitir que ela apareça. Em série ela não pode.
  await new Promise((r) => setTimeout(r, 20));
  expect(inFlight.length, 'nenhuma leitura em voo para responder').toBeGreaterThan(0);
  inFlight.pop()!(value);
  await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  subs.length = 0;
  modeInternal.reset();
  redisMock.get.mockReset();
  redisMock.get.mockResolvedValue(null);
  invalidateModelCacheMock.mockClear();
  incCounterMock.mockClear();
});

afterEach(() => {
  _resetLLMSettingsSubscriberForTests();
  modeInternal.reset();
});

describe('kill switch — releitura na reconexão', () => {
  it('o primeiro `ready` NÃO ressincroniza: o boot já tem o caminho dele', async () => {
    const before = llmSettingsSubscriberResyncCount();
    await bootSubscriber();
    // Uma releitura aqui só duplicaria os eventos de auditoria do boot.
    expect(llmSettingsSubscriberResyncCount()).toBe(before);
    expect(resyncReasons()).toEqual([]);
  });

  /**
   * O cenário do owner. A mensagem do incidente foi publicada com o socket
   * caído — ela NÃO chega, nem depois. Só a releitura da chave durável tira
   * esta réplica da postura do contrato antes do TTL.
   */
  it('override publicado durante a queda é adotado quando o socket volta', async () => {
    const sub = await bootSubscriber();
    expect(effectiveMode()).toBe(modeInternal.baselineMode());

    // O operador virou a chave enquanto esta réplica estava fora: `SET` no
    // Redis, `PUBLISH` perdido (nenhuma mensagem é entregue ao subscriber).
    redisMock.get.mockResolvedValue(overridePayload('off'));

    await reconnect(sub);

    expect(
      effectiveMode(),
      'réplica continuou na postura do contrato depois de reconectar: o PUBLISH perdido nunca volta',
    ).toBe('off');
    expect(redisMock.get).toHaveBeenCalledWith(LLM_CIRCUIT_OVERRIDE_KEY);
    expect(resyncReasons()).toContain('resynced');
  });

  it('a releitura re-inscreve nos DOIS canais e solta o cache de settings', async () => {
    const sub = await bootSubscriber();
    const subscribesBefore = sub.subscribe.mock.calls.length;
    invalidateModelCacheMock.mockClear();

    await reconnect(sub);

    expect(sub.subscribe.mock.calls.length).toBeGreaterThan(subscribesBefore);
    expect(sub.subscribe.mock.calls.at(-1)).toEqual([
      LLM_SETTINGS_INVALIDATION_CHANNEL,
      LLM_CIRCUIT_OVERRIDE_CHANNEL,
    ]);
    // O canal de settings não tem chave durável: o autoritativo é o Postgres,
    // então soltar o cache local É a releitura dele.
    expect(invalidateModelCacheMock).toHaveBeenCalled();
  });

  /**
   * O `clear` do plantão também é uma mensagem, e também se perde. Sem a
   * releitura, esta réplica seguiria recusando tráfego depois de o disjuntor
   * ter sido desligado — o modo de falha que bloqueia o `enforce`.
   */
  it('chave AUSENTE limpa o override local: o `clear` perdido também converge', async () => {
    const sub = await bootSubscriber();
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('off'));
    expect(effectiveMode()).toBe('off');

    // `clear` durante a queda: DEL no Redis, PUBLISH perdido.
    redisMock.get.mockResolvedValue(null);
    await reconnect(sub);

    expect(
      effectiveMode(),
      'override stale sobreviveu ao `clear` que esta réplica não ouviu',
    ).toBe(modeInternal.baselineMode());
    expect(currentOverride()).toBeNull();

    // …e isto é CONVERGÊNCIA, não divergência. O par com o teste do
    // `superseded`: a review do dono foi sobre desfecho divergente publicado
    // como verde, e a correção óbvia demais é alargar `DIVERGENT_OUTCOMES` até
    // ele engolir os desfechos legítimos. `cleared` é o mais comum de todos —
    // é o plantonista desligando o disjuntor — e transformá-lo em
    // `resync_failed` faria a série gritar em toda operação normal. Alarme que
    // toca sempre e alarme que nunca toca acabam no mesmo lugar: ninguém olha.
    expect(
      resyncReasons(),
      'a limpeza convergente foi publicada como falha de resync',
    ).toEqual(['resynced']);
  });

  it('chave ausente E sem override local é no-op — mas ainda é um evento contado', async () => {
    const sub = await bootSubscriber();
    await reconnect(sub);

    expect(currentOverride()).toBeNull();
    // Convergência observável: o silêncio não pode ser a única resposta para
    // "esta réplica ressincronizou depois da queda?".
    expect(resyncReasons()).toEqual(['resynced']);
  });

  /**
   * FAIL-CLOSED. Um `GET` que falhou não é "não há override" — é "não sei".
   * Concluir o desligamento do kill switch a partir de uma falha de Redis é a
   * direção exatamente errada.
   */
  it('releitura que FALHA preserva o override e grita — não conclui "sem override"', async () => {
    const sub = await bootSubscriber();
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('off'));
    expect(effectiveMode()).toBe('off');

    redisMock.get.mockRejectedValue(new Error('LOADING Redis is loading the dataset in memory'));
    await reconnect(sub);

    expect(
      effectiveMode(),
      'a réplica concluiu "sem override" a partir de um Redis que não respondeu',
    ).toBe('off');
    expect(currentOverride()).not.toBeNull();
    expect(resyncReasons()).toEqual(['resync_failed']);
  });

  it('chave ILEGÍVEL também é fail-closed: não dá para concluir nada de JSON quebrado', async () => {
    const sub = await bootSubscriber();
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('off'));

    redisMock.get.mockResolvedValue('{nao-e-json');
    await reconnect(sub);

    expect(effectiveMode()).toBe('off');
    expect(resyncReasons()).toEqual(['resync_failed']);
  });

  /**
   * IDEMPOTÊNCIA E ORDEM. O `GET` da releitura viaja na conexão compartilhada e
   * as mensagens do canal na conexão do subscriber: são dois sockets, e a
   * resposta do `GET` pode chegar ao processo DEPOIS de uma mensagem que o
   * Redis atendeu depois dele. Sem a guarda de geração, a releitura
   * sobrescreveria o valor mais novo pelo mais velho e o estado final seria o
   * da corrida, não o do Redis.
   */
  it('mensagem do canal que chega com o `GET` em voo VENCE a releitura', async () => {
    const sub = await bootSubscriber();

    let releaseGet!: (v: string | null) => void;
    redisMock.get.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          releaseGet = resolve;
        }),
    );

    const before = llmSettingsSubscriberResyncCount();
    sub.emit('ready');
    // Espera o `GET` estar realmente em voo antes de abrir a corrida.
    const deadline = Date.now() + 1000;
    while (typeof releaseGet !== 'function' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }

    // Chega a virada NOVA pelo canal, com o `GET` ainda pendurado.
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('enforce'));
    expect(effectiveMode()).toBe('enforce');

    // …e só então o Redis responde com o estado VELHO que ele tinha quando o
    // `GET` foi atendido.
    releaseGet(overridePayload('off'));
    const settle = Date.now() + 1000;
    while (llmSettingsSubscriberResyncCount() === before && Date.now() < settle) {
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(
      effectiveMode(),
      'a releitura em voo sobrescreveu uma mensagem mais nova: o estado final virou o da corrida',
    ).toBe('enforce');
    // `superseded` é CONVERGÊNCIA legítima, não falha: quem venceu foi uma
    // mensagem do canal, que é sempre pelo menos tão nova quanto o que o `GET`
    // leu — o estado final É o do Redis. Jogá-lo no mesmo balde de
    // `resync_failed` encheria o alerta de divergência com ruído de corrida
    // normal e cegaria o sinal que a #534 criou.
    expect(resyncReasons()).toEqual(['resynced']);
    expect(
      resyncReasons(),
      'corrida perdida para o canal virou alerta de divergência: o balde errado',
    ).not.toContain('resync_failed');
  });

  /**
   * Idempotência do caso comum: reler a MESMA postura que já vale não pode
   * virar uma mudança de estado (nem uma linha de auditoria de mudança).
   */
  it('reler a mesma postura que já vale é idempotente', async () => {
    const sub = await bootSubscriber();
    const payload = overridePayload('off');
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, payload);
    const applied = currentOverride();

    redisMock.get.mockResolvedValue(payload);
    await reconnect(sub);

    expect(effectiveMode()).toBe('off');
    expect(currentOverride()).toEqual(applied);
  });

  /**
   * GOVERNANÇA. A releitura não inventa ação nova na taxonomia (o desfecho é o
   * mesmo de adotar a chave no boot: a postura mudou), mas a PROCEDÊNCIA tem
   * que sobreviver na trilha durável — é ela que responde "por que a postura
   * desta réplica mudou às 3h se ninguém digitou nada?".
   */
  it('a trilha durável distingue a procedência: `source = resynced`', async () => {
    const sub = await bootSubscriber();
    const audit = vi.mocked(recordCircuitAudit);
    audit.mockClear();

    redisMock.get.mockResolvedValue(overridePayload('off'));
    await reconnect(sub);

    const call = audit.mock.calls.find(
      (c) => (c[1] as { source?: string }).source === 'resynced',
    );
    expect(call, 'a mudança de postura da releitura não deixou procedência na trilha').toBeTruthy();
    expect(call![0]).toBe('llm_circuit_mode_override_applied');
    expect(call![1]).toMatchObject({ mode: 'off', actor: ACTOR });
  });

  it('flapping: cada volta do socket produz UMA releitura, em série', async () => {
    const sub = await bootSubscriber();
    const before = llmSettingsSubscriberResyncCount();

    sub.emit('ready');
    sub.emit('ready');
    sub.emit('ready');

    const deadline = Date.now() + 1000;
    while (llmSettingsSubscriberResyncCount() < before + 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(llmSettingsSubscriberResyncCount()).toBe(before + 3);
  });

  /**
   * HIGH da revisão do dono da #552 — a fronteira entre "chave ilegível" e
   * "chave legível porém inaceitável".
   *
   * Um payload que É JSON e É objeto, mas que a governança recusa (sem
   * `expires_at` absoluto, sem ator, vencido, acima do teto), fazia
   * `applyCircuitOverride` devolver `applied: false` — e a releitura terminava
   * publicando `reason="resynced"` em `logger.warn`. Ou seja: a réplica RECUSOU
   * o estado autoritativo, seguiu com o dela, e a série afirmava consistência
   * com o Redis. Isso neutraliza justamente o sinal criado para detectar "o
   * kill switch não alcançou uma réplica" — e libera a promoção para `enforce`
   * com evidência verde falsa.
   *
   * O payload aqui é o caso real: chave durável com validade RELATIVA, que a
   * adoção recusa porque reiniciaria o arrendamento a cada leitura.
   */
  it('payload PRESENTE mas recusado é DIVERGÊNCIA, não convergência', async () => {
    const sub = await bootSubscriber();
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('enforce'));
    expect(effectiveMode()).toBe('enforce');
    const audit = vi.mocked(recordCircuitAudit);
    audit.mockClear();

    redisMock.get.mockResolvedValue(
      JSON.stringify({ mode: 'off', actor: ACTOR, reason: REASON, ttl_ms: 60_000 }),
    );
    await reconnect(sub);

    // Estado preservado: recusar não é adotar, e muito menos limpar.
    expect(effectiveMode()).toBe('enforce');
    expect(
      resyncReasons(),
      'recusa do estado autoritativo saiu como convergência: a série mente sobre a réplica',
    ).toEqual(['resync_failed']);

    // A CAUSA continua distinguível na trilha durável — `resync_failed` é o
    // balde do alerta, `rejected` + `source: resynced` é o porquê.
    const call = audit.mock.calls.find(
      (c) => (c[1] as { source?: string }).source === 'resynced',
    );
    expect(call, 'a recusa da releitura não deixou rastro na trilha').toBeTruthy();
    expect(call![0]).toBe('llm_circuit_mode_override_rejected');
  });

  /**
   * MEDIUM da revisão do dono da #552 — sem ack de re-inscrição não existe o
   * argumento de ordenação que sustenta esta releitura.
   *
   * Com a inscrição confirmada, ou o Redis processa o `SET` antes do nosso
   * `GET` (a chave é encontrada), ou processa o `GET` antes e então o `PUBLISH`
   * — que vem sempre depois do `SET` — cai numa inscrição ativa. Sem ack o
   * segundo braço some: um `SET` + `PUBLISH` logo depois do `GET` não chega por
   * canal NEM aparece na leitura. Tratar ausência de chave como autoritativa
   * nesse estado limparia um override VIVO com base numa leitura indefensável.
   */
  it('re-inscrição sem ack: não lê, preserva o estado e conta como falha', async () => {
    const sub = await bootSubscriber();
    handleLLMSettingsInvalidation(LLM_CIRCUIT_OVERRIDE_CHANNEL, overridePayload('off'));
    expect(effectiveMode()).toBe('off');

    redisMock.get.mockClear();
    invalidateModelCacheMock.mockClear();
    sub.subscribe.mockRejectedValueOnce(new Error('NOSCRIPT connection lost'));

    await reconnect(sub);

    expect(
      redisMock.get,
      'leu a chave sem inscrição ativa: a leitura não pode ser tratada como autoritativa',
    ).not.toHaveBeenCalled();
    expect(
      effectiveMode(),
      'estado local foi mexido a partir de uma leitura que não tem argumento de ordenação',
    ).toBe('off');
    expect(resyncReasons()).toEqual(['resync_failed']);
    // O cache de settings continua fail-SOFT: soltá-lo não depende de ordenação
    // e erra sempre para o lado de reler do Postgres.
    expect(invalidateModelCacheMock).toHaveBeenCalled();
  });

  /**
   * SERIALIZAÇÃO — a propriedade que a `resyncChain` existe para dar, e que
   * antes só existia como afirmação num comentário.
   *
   * A guarda de geração sozinha NÃO cobre isto. Ela protege a releitura contra
   * uma mensagem do canal que chegue no meio do voo (essa é sempre pelo menos
   * tão nova quanto o que o `GET` leu). Entre DUAS releituras concorrentes a
   * premissa cai: as duas capturam a mesma geração antes de qualquer aplicação,
   * a primeira a responder aplica e bumpa a geração, e a outra — que pode ser a
   * que leu o estado MAIS NOVO — sai como `superseded`. O que fica valendo é a
   * leitura mais velha: inversão de ordem no kill switch, a classe exata de bug
   * que o resto do desenho combate.
   *
   * O cenário aqui é o pior caso operacional: a leitura velha diz `enforce`, a
   * nova diz `off` (o plantão desligou o disjuntor entre as duas). Se a velha
   * vencer, a réplica segue recusando tráfego que já mandaram parar de recusar.
   */
  it('duas reconexões seguidas correm EM SÉRIE: a leitura mais nova é a que fica', async () => {
    const sub = await bootSubscriber();
    const before = llmSettingsSubscriberResyncCount();

    /** Leituras em voo, na ordem em que a PRODUÇÃO as emitiu. */
    const inFlight: Array<(v: string | null) => void> = [];
    redisMock.get.mockImplementation(
      () => new Promise<string | null>((resolve) => inFlight.push(resolve)),
    );

    // Dois `ready` em sequência rápida, sem esperar o primeiro terminar — o
    // socket instável do comentário, agora exercido de verdade.
    sub.emit('ready');
    sub.emit('ready');

    // A leitura mais recente em voo responde PRIMEIRO, com o valor mais VELHO…
    await answerInFlight(inFlight, overridePayload('enforce'));
    // …e a que sobrar (ou a que a série emitir em seguida) com o mais NOVO.
    await answerInFlight(inFlight, overridePayload('off'));

    await waitUntil(() => llmSettingsSubscriberResyncCount() === before + 2);
    expect(
      llmSettingsSubscriberResyncCount(),
      'as duas releituras precisam TERMINAR — serializar não pode virar engolir uma',
    ).toBe(before + 2);
    expect(
      effectiveMode(),
      'a leitura mais VELHA foi a última a escrever: releituras concorrentes inverteram a ordem do kill switch',
    ).toBe('off');
  });
});
