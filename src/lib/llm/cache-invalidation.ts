/**
 * Invalidação distribuída do cache de settings de modelo (issue #508).
 *
 * Problema: o cache de `model-resolver.ts` vive em memória de processo. Numa
 * réplica só, trocar o modelo pelo Admin passa a valer no próximo TTL. Com N
 * réplicas, cada uma expira num instante diferente — durante um incidente
 * (provider fora do ar, modelo deprecado) esse intervalo é exatamente o
 * tempo em que o operador acha que já trocou e metade do tráfego continua no
 * modelo velho.
 *
 * Solução: o writer publica no Redis, todas as réplicas soltam o cache na
 * hora. O TTL curto continua sendo a rede de segurança — se o Redis estiver
 * fora, a invalidação é perdida mas o cache expira sozinho em segundos
 * (critério explícito da issue: "Redis indisponível não pode manter
 * indefinidamente um modelo antigo").
 *
 * Segue o mesmo padrão do policy cache (`src/control-plane/policy/policy-cache.ts:501`):
 * conexão de subscriber dedicada (um cliente IORedis em modo subscribe não
 * pode executar outros comandos), `lazyConnect`, erros só logados.
 *
 * Canal único (não por tenant) porque `global_settings` é process-wide por
 * design (issue #183): a troca de modelo não é per-tenant, então não há
 * escopo a estreitar. Se as settings virarem per-tenant, este canal vira
 * `maia:llm:settings:invalidate:<tenant>` e o handler passa o escopo para
 * `invalidateModelCache`.
 *
 * ## Segundo canal: o kill switch do disjuntor (#534, revisão do owner)
 *
 * `maia:llm:circuit:override` carrega a postura do disjuntor
 * (`circuit-mode.ts`). Ele anda NESTE subscriber, e não num novo, por três
 * razões práticas:
 *
 *  1. A conexão já existe, já é `lazyConnect`, e já é fechada no passo
 *     `llm_settings_subscriber` da sequência de drain (#512). Um subscriber
 *     novo exigiria mexer em `src/index.ts` e em `shutdown-sequence.ts` — e um
 *     socket ioredis esquecido aberto é exatamente o bug que travou a #512.
 *  2. Os dois canais têm o mesmo público (toda réplica que chama LLM) e a
 *     mesma janela de vida.
 *  3. Um pub/sub perde mensagem para quem não estava inscrito na hora, então a
 *     postura também mora numa CHAVE durável com TTL: quem sobe no meio do
 *     incidente adota o resto do arrendamento em vez de voltar sozinho para a
 *     postura do contrato. A chave é gravada SEMPRE com `PX` e SEMPRE com
 *     `expires_at` absoluto — as duas coisas juntas são o que garante que o
 *     kill switch pode ser esquecido sem virar configuração permanente. E o
 *     `GET` da adoção só acontece depois do `SUBSCRIBE` confirmado, senão a
 *     réplica que sobe durante a virada da chave fica na postura antiga
 *     justamente durante o incidente. Os dois argumentos por extenso em
 *     `publishCircuitOverride` e `startLLMSettingsInvalidationSubscriber`.
 *
 * O hot path do disjuntor continua sem tocar em Redis: o que vem por aqui é
 * notificação, não consulta. Redis fora ⇒ o override não propaga, e o runbook
 * manda usar a segunda alavanca (`LLM_CIRCUIT_MODE=off` + restart).
 */
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { redis } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { counter, METRIC } from '@/observability/metrics.js';
import {
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  applyCircuitOverride,
  currentOverride,
  effectiveMode,
  handleCircuitOverrideMessage,
  overrideGeneration,
  resolveOverrideExpiry,
} from './circuit-mode.js';
import type { CircuitOverrideMessage } from './circuit-mode.js';
import { invalidateModelCache } from './model-resolver.js';

export const LLM_SETTINGS_INVALIDATION_CHANNEL = 'maia:llm:settings:invalidate';

/** Os dois canais deste subscriber, numa lista só: quem inscreve e quem RE-inscreve. */
const SUBSCRIBED_CHANNELS = [
  LLM_SETTINGS_INVALIDATION_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
] as const;

let subscriberStarted = false;
let subscriber: IORedis | null = null;
/**
 * Resolve quando o `SUBSCRIBE` já foi confirmado pelo Redis E a adoção da
 * chave durável terminou. É o que dá a QUEM ESPERA (drain, testes, diagnóstico)
 * um ponto em que a réplica sabidamente já convergiu — sem ele, "o subscriber
 * subiu" era uma afirmação que ninguém podia verificar. Nunca rejeita.
 */
let subscriberReady: Promise<void> = Promise.resolve();

/**
 * Publica a invalidação. Best-effort: uma falha de Redis não pode derrubar a
 * escrita das settings, que já foi commitada no Postgres. O counter é o que
 * permite alertar quando as réplicas estão dessincronizadas.
 */
export async function publishLLMSettingsInvalidation(): Promise<void> {
  try {
    await redis.publish(LLM_SETTINGS_INVALIDATION_CHANNEL, JSON.stringify({ at: Date.now() }));
    incCounter('maia_llm_settings_cache_total', { result: 'invalidation_published' });
  } catch (err) {
    incCounter('maia_llm_settings_cache_total', { result: 'invalidation_publish_failed' });
    logger.warn(
      { err: (err as Error).message, channel: LLM_SETTINGS_INVALIDATION_CHANNEL },
      'llm_gateway.settings_invalidation_publish_failed',
    );
  }
}

/**
 * Publica a postura do disjuntor para TODA a frota — o kill switch da #534.
 *
 * Escreve a chave durável ANTES de publicar, e nessa ordem de propósito: uma
 * réplica que sobe entre o `PUBLISH` e o `SET` perderia a mensagem e não
 * acharia a chave. Invertendo, a pior janela é uma réplica adotar a postura um
 * instante antes das outras — que é a direção segura.
 *
 * ## A validade é normalizada AQUI, uma vez só
 *
 * Um `ttl_ms` (relativo) chegando até a chave durável é o bug do kill switch
 * imortal: a chave ficava SEM `PX` — vivendo para sempre — e carregava uma
 * validade que cada réplica reinterpretava contra o próprio boot. Toda réplica
 * que reiniciasse recomeçaria a contagem, e o override sobreviveria a deploys
 * indefinidamente. Um kill switch que não pode ser esquecido é pior que
 * nenhum: ele fixa a postura em silêncio, sem ninguém tendo decidido isso.
 *
 * Então: converte-se para `expires_at` ABSOLUTO, validam-se os limites
 * (vencido / teto de 24h) **antes** de tocar no Redis, grava-se **sempre** com
 * `PX`, e publica-se o MESMO payload normalizado que foi persistido. Assim
 * quem adota a chave e quem recebe a mensagem concordam sobre o instante — e
 * o `PX` do Redis (uma duração, medida pelo próprio Redis) casa com ele.
 *
 * Falha de Redis é propagada (diferente da invalidação de settings, que é
 * best-effort): quem virou o kill switch precisa saber que ele NÃO virou. Um
 * "ok" mentiroso durante incidente é pior que um erro. Validade inválida
 * também lança, e pelo mesmo motivo — melhor um erro no terminal do operador
 * que uma chave gravada com um arrendamento que ninguém pediu.
 */
export async function publishCircuitOverride(
  msg: CircuitOverrideMessage,
  now = Date.now(),
): Promise<void> {
  if (msg.clear === true) {
    const clearPayload = JSON.stringify(msg);
    await redis.del(LLM_CIRCUIT_OVERRIDE_KEY);
    await redis.publish(LLM_CIRCUIT_OVERRIDE_CHANNEL, clearPayload);
    return;
  }

  const expiry = resolveOverrideExpiry(msg, now);
  if ('error' in expiry) throw new Error(`circuit override recusado: ${expiry.error}`);

  // `ttl_ms` é DESCARTADO do payload persistido: manter os dois seria manter
  // duas verdades sobre o mesmo instante, e a relativa é a que ressuscita.
  const { ttl_ms: _relative, ...rest } = msg;
  const payload = JSON.stringify({ ...rest, expires_at: expiry.expires_at });
  // `Math.ceil` + piso de 1: `PX 0` é erro no Redis, e arredondar para baixo
  // faria a chave morrer um milissegundo antes do arrendamento que o payload
  // declara.
  const px = Math.max(1, Math.ceil(expiry.expires_at - now));

  await redis.set(LLM_CIRCUIT_OVERRIDE_KEY, payload, 'PX', px);
  await redis.publish(LLM_CIRCUIT_OVERRIDE_CHANNEL, payload);
}

/**
 * Adota um override que já estava em vigor quando esta réplica subiu.
 *
 * Sem isto, um deploy ou um scale-out no meio do incidente traria réplicas
 * novas com o disjuntor de volta na postura do contrato — metade da frota
 * recusando e metade não, que é o pior dos dois mundos. Best-effort: sem Redis,
 * a réplica simplesmente fica na postura versionada.
 *
 * SÓ pode ser chamada depois do `SUBSCRIBE` confirmado — ver
 * `startLLMSettingsInvalidationSubscriber`, onde o argumento de ordenação está
 * por extenso. A recusa de payload com validade relativa mora em
 * `applyCircuitOverride` (source `adopted`), junto com o resto da auditoria.
 */
async function adoptPersistedOverride(): Promise<void> {
  try {
    const raw = await redis.get(LLM_CIRCUIT_OVERRIDE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    applyCircuitOverride(parsed as CircuitOverrideMessage, Date.now(), 'adopted');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, key: LLM_CIRCUIT_OVERRIDE_KEY },
      'llm_gateway.circuit_override_adopt_failed',
    );
  }
}

/**
 * Ator sintético das mudanças de postura que a RELEITURA causa.
 *
 * `actor` e `reason` são obrigatórios (`applyCircuitOverride`) porque um kill
 * switch anônimo não é auditável. Numa releitura não existe humano: o que
 * mudou a postura foi a convergência com o Redis. Mentir um nome de pessoa
 * seria pior que isto — o par abaixo é honesto, greppável e diz na trilha
 * exatamente por que a postura mudou sem ninguém ter digitado nada.
 */
const RESYNC_ACTOR = 'system:llm_circuit_resync';

/** Quantas releituras de reconexão já TERMINARAM neste processo (sucesso ou não). */
let resyncCount = 0;
/** Serializa releituras: um socket instável pode emitir vários `ready` seguidos. */
let resyncChain: Promise<void> = Promise.resolve();

/**
 * Relê o estado AUTORITATIVO do Redis depois de uma reconexão do subscriber —
 * o gate 4 da #534.
 *
 * ## A lacuna que isto fecha
 *
 * Pub/sub do Redis é at-most-once e não tem replay. O ioredis reconecta o
 * socket sozinho e restaura as inscrições, mas tudo que foi publicado enquanto
 * ele estava fora se perdeu PARA SEMPRE. O cenário concreto: o plantão vira o
 * kill switch às 3h; uma réplica com o socket caído naquele instante não recebe
 * o `PUBLISH` e continua recusando tráfego até o TTL natural do arrendamento —
 * a alavanca de incidente falha exatamente no cenário para o qual ela existe.
 * `adoptPersistedOverride` cobria quem SOBE no meio do incidente; isto cobre
 * quem RECONECTA nele.
 *
 * É a RELEITURA que fecha a lacuna, não a re-inscrição: o `subscribe` sozinho
 * só garante as mensagens FUTURAS, e a mensagem perdida é passada.
 *
 * ## O que é relido, canal por canal
 *
 *  - **Override do disjuntor** — tem chave durável (`LLM_CIRCUIT_OVERRIDE_KEY`),
 *    então a releitura é literal: `GET` + reaplicação. Chave presente ⇒ adota o
 *    que sobrou do arrendamento (o payload carrega `expires_at` ABSOLUTO, então
 *    não há como reiniciar a contagem). Chave ausente ⇒ o override local é
 *    stale e cai: pode ter havido um `clear` durante a queda, e é justamente
 *    esse o caso em que a réplica ficaria recusando tráfego depois de o plantão
 *    ter desligado o disjuntor.
 *  - **Cache de settings de modelo** — não tem chave no Redis; o estado
 *    autoritativo é o Postgres e o canal só carrega "solte o cache". A
 *    releitura equivalente é soltar o cache local, que força a próxima
 *    resolução a ir ao banco. Barato e na direção segura.
 *
 * ## Fail-closed
 *
 * Se o `GET` FALHAR, esta réplica NÃO conclui "não há override": o estado local
 * é preservado (um override em vigor continua em vigor) e o evento sai contado
 * em `reason="resync_failed"` + log de ERRO. Concluir "não há override" a partir
 * de um Redis que não respondeu seria inventar um desligamento do kill switch
 * durante uma falha de Redis — a direção exatamente errada. Chave ilegível
 * (JSON corrompido) segue a mesma regra: não dá para concluir nada dela.
 */
async function resyncAuthoritativeState(sub: IORedis): Promise<void> {
  try {
    // Re-inscrever de propósito, mesmo com `autoResubscribe` do ioredis ligado:
    // o `await` no ack é o que dá o MESMO argumento de ordenação do boot (Redis
    // é single-threaded, então um `GET` posterior ao ack não pode perder um
    // `PUBLISH` que venha depois do `SET`). Re-inscrição num canal já inscrito é
    // idempotente no Redis.
    await sub.subscribe(...SUBSCRIBED_CHANNELS);
  } catch (err) {
    // Sem ack não há garantia de ordem, mas a releitura ainda vale mais que
    // nada — mesmo raciocínio do boot.
    logger.warn(
      { err: (err as Error).message, channels: SUBSCRIBED_CHANNELS },
      'llm_gateway.settings_resubscribe_failed',
    );
  }

  // Settings: o autoritativo é o Postgres, então soltar o cache local É a
  // releitura. Feito antes do `GET` porque não depende dele nem pode falhar.
  invalidateModelCache();

  // A geração é capturada ANTES do `GET`: se uma mensagem do canal for aplicada
  // enquanto a resposta está em voo, ela é pelo menos tão nova quanto o que o
  // `GET` leu e a releitura CEDE. Argumento completo em `circuit-mode.ts`,
  // bloco de `generation`.
  const generation = overrideGeneration();
  let raw: string | null;
  try {
    raw = await redis.get(LLM_CIRCUIT_OVERRIDE_KEY);
  } catch (err) {
    finishResync('failed', { error: (err as Error).message });
    return;
  }

  if (overrideGeneration() !== generation) {
    finishResync('superseded');
    return;
  }

  if (raw === null) {
    // Ausência é resposta AUTORITATIVA (diferente de erro, acima): a chave
    // expirou ou foi apagada por um `clear` que esta réplica não ouviu.
    if (currentOverride() === null) {
      finishResync('noop');
      return;
    }
    applyCircuitOverride(
      {
        clear: true,
        actor: RESYNC_ACTOR,
        reason: 'chave do override ausente no Redis após reconexão',
      },
      Date.now(),
      'resynced',
    );
    finishResync('cleared');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    finishResync('failed', { error: `chave ilegível: ${(err as Error).message}` });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    finishResync('failed', { error: 'chave ilegível: payload não é objeto' });
    return;
  }

  const result = applyCircuitOverride(parsed as CircuitOverrideMessage, Date.now(), 'resynced');
  // Recusa (validade vencida, payload sem `expires_at`, sem ator) já foi
  // contada e auditada como `rejected` por `applyCircuitOverride`. O estado
  // local é PRESERVADO — mesma regra do erro de leitura.
  finishResync(result.applied ? 'applied' : 'rejected', { error: result.error });
}

type ResyncOutcome = 'applied' | 'cleared' | 'noop' | 'superseded' | 'rejected' | 'failed';

/**
 * Convergência OBSERVÁVEL: um evento por releitura, sempre, mesmo quando ela
 * não muda nada — é o que permite responder "esta réplica ressincronizou depois
 * da queda?" em vez de inferir do silêncio.
 *
 * Fica na família que já existe (`maia_llm_circuit_mode_overrides_total`), com
 * dois valores novos de `reason`: `resynced` (a releitura terminou; `state` é a
 * postura que ficou valendo) e `resync_failed` (não terminou; `state` é a
 * postura PRESERVADA, que pode estar divergente da frota). Métrica nova seria
 * uma família a mais respondendo sobre o mesmo controle.
 *
 * `attribute: false` pelo mesmo motivo do resto do módulo: a postura é da
 * frota, e o `tenant_id` que por acaso estava no ALS não diz nada sobre ela.
 */
function finishResync(outcome: ResyncOutcome, detail: { error?: string } = {}): void {
  resyncCount++;
  const state = effectiveMode();
  counter(
    METRIC.LLM_CIRCUIT_MODE_OVERRIDES,
    { state, reason: outcome === 'failed' ? 'resync_failed' : 'resynced' },
    1,
    { attribute: false },
  );
  const record = { outcome, state, key: LLM_CIRCUIT_OVERRIDE_KEY, err: detail.error };
  if (outcome === 'failed') {
    // ERROR, não WARN: uma réplica que não conseguiu reler pode estar recusando
    // tráfego que o plantão já mandou parar de recusar, e ninguém a acordou.
    logger.error(record, 'llm_gateway.circuit_override_resync_failed');
    return;
  }
  logger.warn(record, 'llm_gateway.circuit_override_resynced');
}

/**
 * Aplica a invalidação local. Exportado separado do wiring de Redis para que o
 * teste possa exercer o handler sem subir um subscriber.
 */
export function handleLLMSettingsInvalidation(channel: string, payload = ''): void {
  if (channel === LLM_CIRCUIT_OVERRIDE_CHANNEL) {
    handleCircuitOverrideMessage(payload);
    return;
  }
  if (channel !== LLM_SETTINGS_INVALIDATION_CHANNEL) return;
  invalidateModelCache();
  logger.info(
    { channel },
    'llm_gateway.settings_cache_invalidated',
  );
}

/**
 * Idempotente: chamar mais de uma vez não abre conexões extras.
 *
 * ## Por que a adoção só acontece DEPOIS do `SUBSCRIBE` confirmado
 *
 * `subscribe()` do ioredis é assíncrono: disparar e seguir para o `GET` na
 * mesma volta do event loop NÃO põe o `GET` "depois do subscribe" — põe antes,
 * quase sempre. A janela que isso abre é exatamente a que mais dói: réplica
 * sobe, faz `GET` e não acha nada; o operador roda `SET` + `PUBLISH`; a
 * mensagem se perde porque a inscrição ainda não estava ativa; e essa réplica
 * atravessa o incidente inteiro na postura do contrato enquanto o resto da
 * frota está com o kill switch virado.
 *
 * Esperando a confirmação do `SUBSCRIBE` antes do `GET`, as duas
 * interleavings possíveis convergem — e é o Redis single-threaded que fecha o
 * argumento, porque ele serializa os comandos das duas conexões numa ordem
 * total:
 *
 *  - Redis processa o `SET` do publisher ANTES do nosso `GET` ⇒ o `GET` acha a
 *    chave e a réplica adota. (O `PUBLISH` que vem depois só reafirma.)
 *  - Redis processa o nosso `GET` ANTES do `SET` ⇒ o `GET` volta vazio, mas o
 *    `PUBLISH` do publisher é necessariamente processado depois do nosso
 *    `SUBSCRIBE` (que já foi confirmado) e depois do `SET` (que
 *    `publishCircuitOverride` faz primeiro, sempre) ⇒ a mensagem é entregue.
 *
 * Não há terceiro caso: `publishCircuitOverride` garante `SET` antes de
 * `PUBLISH`, e o `SUBSCRIBE` confirmado garante entrega de todo `PUBLISH`
 * posterior. Por isso a adoção é um `GET` só, sem double-read.
 *
 * **O que continua best-effort, dito com todas as letras:** se o `SUBSCRIBE`
 * FALHAR, a adoção ainda roda — é melhor que nada — mas sem ordenação
 * garantida, e é o cenário do log
 * `settings_subscribe_failed_natural_ttl_only`.
 *
 * **Quem RECONECTA** é coberto por `resyncAuthoritativeState`, encadeada no
 * `ready` do ioredis a partir da SEGUNDA vez (gate 4 da #534). Pub/sub é
 * at-most-once e não tem replay: a mensagem publicada durante a queda do socket
 * está perdida, e é a RELEITURA da chave durável — não a re-inscrição — que faz
 * a réplica convergir sem esperar o TTL do arrendamento.
 */
export function startLLMSettingsInvalidationSubscriber(): void {
  if (subscriberStarted) return;
  subscriberStarted = true;

  const sub = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  subscriber = sub;
  sub.on('error', (err) => {
    logger.warn({ err: err.message }, 'llm_gateway.settings_subscriber_error');
  });
  sub.connect().catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      'llm_gateway.settings_subscribe_connect_failed',
    );
  });
  sub.on('message', (channel, payload) => handleLLMSettingsInvalidation(channel, payload));

  /**
   * A RECONEXÃO. O ioredis emite `ready` no primeiro connect e de novo a cada
   * reconexão bem-sucedida; só a segunda em diante é queda-e-volta. O primeiro
   * `ready` é ignorado porque o boot já tem o seu caminho de convergência (o
   * `GET` encadeado no ack do `subscribe`, abaixo) — releitura em dobro no boot
   * só duplicaria eventos de auditoria.
   *
   * A flag é do SUBSCRIBER, não do módulo: cada `start` cria uma conexão nova, e
   * o primeiro `ready` DELA é sempre um boot.
   */
  let readySeen = false;
  sub.on('ready', () => {
    if (!readySeen) {
      readySeen = true;
      return;
    }
    resyncChain = resyncChain.then(() => resyncAuthoritativeState(sub));
  });

  const channels = [...SUBSCRIBED_CHANNELS];
  // A promise do `subscribe` só resolve quando o Redis CONFIRMA a inscrição —
  // é esse ack, e não a chamada, que torna verdadeira a frase "depois do
  // subscribe". O `GET` da adoção é encadeado nele.
  subscriberReady = sub
    .subscribe(...channels)
    .then(() => {
      logger.info({ channels }, 'llm_gateway.settings_invalidation_subscriber_started');
    })
    .catch((err: unknown) => {
      // Degradação documentada: sem subscribe, cada réplica ainda converge
      // pelo TTL curto do cache — e o kill switch do disjuntor cai na segunda
      // alavanca (`LLM_CIRCUIT_MODE=off` + restart), como o runbook manda. A
      // adoção abaixo ainda roda (melhor um GET sem garantia de ordem que
      // nenhum), só não vale o argumento de ordenação.
      logger.warn(
        { err: (err as Error).message, channels },
        'llm_gateway.settings_subscribe_failed_natural_ttl_only',
      );
    })
    .then(() => adoptPersistedOverride());
}

/**
 * Resolve quando a inscrição foi confirmada e a chave durável já foi adotada.
 * Existe para que um caller possa AFIRMAR a convergência em vez de dormir um
 * tempinho e torcer — é o que os testes de corrida usam.
 *
 * Nunca REJEITA (falha de subscribe já vira log + adoção degradada), mas com o
 * Redis fora ela também não resolve: ioredis fica reconectando e o `SUBSCRIBE`
 * segue enfileirado. Por isso o boot (`src/index.ts:184`) dispara e segue —
 * quem espera aqui deve trazer o próprio deadline.
 */
export function llmSettingsSubscriberReady(): Promise<void> {
  return subscriberReady;
}

/**
 * Quantas releituras de reconexão já TERMINARAM neste processo. Monotônico e
 * de diagnóstico: é o ponto em que um teste (ou um `/debug`) pode AFIRMAR que a
 * réplica passou pela convergência, em vez de dormir e torcer. A série
 * equivalente para alerta é
 * `maia_llm_circuit_mode_overrides_total{reason="resynced"}`.
 */
export function llmSettingsSubscriberResyncCount(): number {
  return resyncCount;
}

/**
 * Fecha a conexão do subscriber. Chamado pelo passo `llm_settings_subscriber`
 * da sequência de drain (issue #512, `src/runtime/lifecycle/shutdown-sequence.ts`).
 *
 * Por que existe: este subscriber tem ioredis PRÓPRIA — ioredis proíbe outros
 * comandos num cliente inscrito, então o `quit()` do pool compartilhado não o
 * alcança. Um socket assim, deixado aberto, mantém o event loop vivo depois de
 * um drain limpo e faz TODO deploy reportar shutdown forçado. Foi exatamente
 * esse o bug que travou a #512 com o subscriber da #511.
 *
 * Nunca lança: um drain não pode falhar porque um socket já estava morto.
 */
export async function stopLLMSettingsInvalidationSubscriber(): Promise<void> {
  const pending = subscriber;
  subscriber = null;
  subscriberStarted = false;
  subscriberReady = Promise.resolve();
  if (!pending) return;
  try {
    await pending.quit();
  } catch (err) {
    // Já caiu, ou nunca terminou de conectar. Não há o que fechar.
    logger.warn(
      { err: (err as Error).message },
      'llm_gateway.settings_subscriber_close_failed',
    );
  }
}

/** Test-only. Produção não deve chamar. */
export function _resetLLMSettingsSubscriberForTests(): void {
  subscriberStarted = false;
  subscriberReady = Promise.resolve();
  void subscriber?.quit().catch(() => undefined);
  subscriber = null;
}
