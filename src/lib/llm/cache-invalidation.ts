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
 * Ciclo de vida de UM subscriber — a dimensão que faltava na review do dono da
 * #561 (achado 2).
 *
 * ## Por que não dá para reusar `overrideGeneration()`
 *
 * A geração do override responde "alguém aplicou uma postura mais nova que a
 * que esta leitura está carregando?". É uma pergunta sobre o ESTADO. Aqui a
 * pergunta é outra: "o subscriber que disparou esta releitura ainda existe?" —
 * sobre o CICLO DE VIDA do processo. Um `stop()` não muda a postura, e uma
 * mensagem do canal não fecha o socket; empilhar as duas numa variável só faria
 * `superseded` e "drenado" indistinguíveis, e são desfechos com severidades
 * opostas. São contadores separados de propósito.
 *
 * ## O que isto conserta
 *
 * `stopLLMSettingsInvalidationSubscriber()` fechava a conexão e ia embora. Uma
 * releitura em backoff, ou com um `GET` em voo, acordava depois do `quit()`,
 * gastava as tentativas restantes contra um cliente encerrado e terminava em
 * `finishResync('failed')` — que nesta PR virou alerta: um drain deliberado
 * podia PAGINAR (`state="enforce"`) uma réplica que estava só saindo. O `unref`
 * dos timers não cobre isso: ele impede segurar o event loop, não impede a
 * emissão enquanto o resto do drain ainda o mantém vivo.
 *
 * `stopped` é uma promise que RESOLVE (nunca rejeita) no fechamento, e entra
 * nos mesmos `Promise.race` do deadline e do backoff. Assim o fechamento
 * INTERROMPE a releitura na hora, em vez de só ser notado no próximo ponto de
 * verificação — que, com um `GET` pendurado, seria até 2s depois.
 */
interface SubscriberLifecycle {
  /** `false` a partir do `stop()`. Lido em todo ponto de decisão da releitura. */
  alive: boolean;
  /** Resolve no `stop()`. NUNCA rejeita — é sempre consumida dentro de um race. */
  readonly stopped: Promise<void>;
  stop(): void;
}

function newSubscriberLifecycle(): SubscriberLifecycle {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    alive: true,
    stopped,
    stop(): void {
      if (!this.alive) return;
      this.alive = false;
      release();
    },
  };
}

/** Ciclo de vida do subscriber VIVO, ou `null` quando não há nenhum. */
let subscriberLifecycle: SubscriberLifecycle | null = null;

/**
 * Erro sentinela do fechamento. Não carrega informação: quem o pega decide pelo
 * `life.alive`, que é a verdade sobre o ciclo de vida — o erro só serve para
 * tirar o `await` da operação pendurada.
 */
const SUBSCRIBER_STOPPED = new Error('subscriber fechado durante a releitura');

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
/**
 * Serializa releituras: um socket instável pode emitir vários `ready` seguidos.
 *
 * ## E o retry segura a próxima releitura pelo backoff — de propósito
 *
 * Com o retry (abaixo), uma releitura que esgota pode ocupar a cadeia por até
 * ~10s (4 tentativas × timeout + os três backoffs). A próxima espera. Isso é
 * ACEITÁVEL, e não é um efeito colateral que se tolera:
 *
 *  - as duas releituras leem o MESMO estado — a chave durável do override. A
 *    segunda não tem informação nova a entregar, só uma leitura mais recente;
 *  - serializar é o que garante que a leitura mais NOVA é a que fica. Duas
 *    releituras concorrentes capturam a mesma geração antes de qualquer
 *    aplicação, e a primeira a responder pode ser a que leu o estado mais
 *    velho — inversão de ordem no kill switch. É o caso provado em
 *    `tests/unit/lib/llm-circuit-resync.spec.ts` ("duas reconexões seguidas
 *    correm EM SÉRIE");
 *  - um socket que flapa durante uma queda de Redis produziria N releituras
 *    concorrentes, cada uma com 4 tentativas, martelando o Redis já doente.
 *    A cadeia é também o freio disso.
 *
 * O preço é a latência de convergência num flapping: a releitura que importa
 * (a última) começa depois que a anterior desiste. Contra o TTL do
 * arrendamento (30min default, teto de 24h) os ~10s são ruído.
 */
let resyncChain: Promise<void> = Promise.resolve();

/**
 * Retry LIMITADO da releitura — decisão do owner na #534.
 *
 * > "Sim, mas limitado. Sugestão: tentativa imediata mais três retries com
 * > backoff, jitter e timeout por tentativa. Preservar o estado local em todas
 * > as falhas e emitir `resync_failed` definitivo somente depois do
 * > esgotamento."
 *
 * O porquê: a falha típica aqui é TRANSITÓRIA — `LOADING` durante um failover,
 * um `GET` que pegou o socket no meio da volta, um ack de `SUBSCRIBE` que se
 * perdeu na reconexão. Desistir na primeira produzia duas coisas ruins ao mesmo
 * tempo: uma réplica que ficava divergente até o TTL do arrendamento por causa
 * de um soluço de 200ms, e um `resync_failed` que não distinguia soluço de
 * Redis inalcançável — alerta que toca por ruído é alerta que ninguém olha.
 *
 * Números, e o que cada um compra:
 *
 *  - **4 tentativas** (1 imediata + 3 retries). A imediata é o caso comum (o
 *    socket acabou de voltar e o Redis está lá). Três retries cobrem um
 *    failover curto sem transformar a releitura numa operação de minutos.
 *  - **deadline POR TENTATIVA, da tentativa INTEIRA**. É o que impede a
 *    degeneração para "uma tentativa eterna": um socket meio-aberto contra um
 *    nó em failover pode nunca responder o `GET`, e sem deadline a cadeia
 *    inteira trava e o desfecho terminal nunca sai.
 *  - **backoff exponencial com jitter**. Quando o Redis cai, TODA a frota
 *    reconecta junto; sem jitter as N réplicas voltam a bater nele no mesmo
 *    milissegundo, três vezes seguidas.
 *
 * ## O teto, e por que ele é DEMONSTRÁVEL (achado 1 da review do dono na #561)
 *
 * O deadline vale para a tentativa inteira, não para cada operação dela. A
 * primeira versão armava um timer novo para o ack de `SUBSCRIBE` e outro para o
 * `GET`: um subscribe resolvendo perto dos 2s somado a um `GET` pendurado dava
 * uma tentativa de quase 4s, e a cadeia inteira ia a ~18s — quase o dobro do
 * orçamento que este bloco declarava. `attemptResync` fixa um instante-limite
 * no começo da tentativa e as duas operações correm contra o que SOBRA dele;
 * uma terceira operação que alguém acrescente ali dentro herda o mesmo teto sem
 * ninguém precisar refazer a conta.
 *
 * Pior caso, com a conta fechada:
 *
 *     4 × 2 000 ms (deadlines)        =  8 000 ms
 *     + 300 + 600 + 1 200 (backoffs)  =  2 100 ms   ← base × 2^(n-1), jitter máximo (×1,5)
 *     ------------------------------------------
 *                                      10 100 ms
 *
 * ~10,1s, e é o que `resyncWorstCaseMs()` calcula — a mesma conta, num lugar
 * só, para docs e testes citarem em vez de repetir literais. Deliberadamente
 * muito abaixo do arrendamento mínimo sancionado (30min): se o Redis não
 * respondeu em 10s, ele não é um soluço, e a resposta certa é acordar o plantão
 * — não continuar tentando.
 *
 * NÃO é configurável por env: mexer nisto muda o contrato de config, que a
 * issue manda escalar em vez de decidir.
 */
export const RESYNC_RETRY = {
  /** Tentativa imediata + 3 retries. */
  attempts: 4,
  /**
   * Deadline de CADA tentativa, cobrindo o ack de `SUBSCRIBE` e o `GET`
   * JUNTOS. A segunda operação corre contra o que sobrou da primeira.
   */
  attemptTimeoutMs: 2_000,
  /** Backoff: 200 · 400 · 800 ms, cada um com jitter de ±50%. */
  backoffBaseMs: 200,
} as const;

/**
 * Teto de tempo de UMA releitura que esgota o retry, no pior jitter.
 *
 * Existe para que a conta viva num lugar só: o comentário de `RESYNC_RETRY`, o
 * `lib.md`, os runbooks e os testes citam ESTE número. Um teto escrito à mão em
 * quatro lugares diverge do código no primeiro ajuste dos parâmetros.
 *
 * `attempts × attemptTimeoutMs` são os deadlines; o somatório é o dos
 * `attempts - 1` backoffs — `backoffBaseMs × 2^(n-1)` cada um, multiplicado
 * pelo jitter MÁXIMO (1,5), que é o pior caso que `resyncBackoffMs` produz.
 */
export function resyncWorstCaseMs(): number {
  const deadlines = RESYNC_RETRY.attempts * RESYNC_RETRY.attemptTimeoutMs;
  let backoffs = 0;
  for (let attempt = 1; attempt <= RESYNC_RETRY.attempts - 1; attempt++) {
    backoffs += RESYNC_RETRY.backoffBaseMs * 2 ** (attempt - 1) * 1.5;
  }
  return deadlines + backoffs;
}

/**
 * Corre `op` contra o que SOBRA do deadline da tentativa — e contra o
 * fechamento do subscriber.
 *
 * O `deadline` é um instante ABSOLUTO fixado no começo da tentativa por
 * `attemptResync`. Passar o instante (e não uma duração) é o que faz a segunda
 * operação herdar o orçamento já gasto pela primeira: é a diferença entre "cada
 * operação tem 2s" e "a tentativa tem 2s".
 *
 * O timer é `unref`ado: um retry pendurado NÃO pode ser motivo de o processo
 * ficar vivo depois de um drain limpo — ver o aviso sobre drain em
 * `resyncAuthoritativeState`. `Promise.race` já registra handler em todas as
 * pontas, então uma rejeição tardia de `op` não vira `unhandledRejection`.
 */
async function withAttemptDeadline<T>(
  op: Promise<T>,
  what: string,
  deadline: number,
  life: SubscriberLifecycle,
): Promise<T> {
  const expired = new Error(
    `${what} não coube no deadline de ${RESYNC_RETRY.attemptTimeoutMs}ms da tentativa`,
  );
  // Orçamento já gasto pela operação anterior da MESMA tentativa: não se abre
  // um timer de duração negativa, e não se dá à segunda operação um prazo que a
  // tentativa não tem mais.
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw expired;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(expired), remaining);
        timer.unref?.();
      }),
      life.stopped.then((): never => {
        throw SUBSCRIBER_STOPPED;
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Backoff exponencial com jitter de ±50% sobre o passo daquela tentativa. */
function resyncBackoffMs(attempt: number): number {
  const step = RESYNC_RETRY.backoffBaseMs * 2 ** (attempt - 1);
  return Math.round(step * (0.5 + Math.random()));
}

/** Espera `ms`. Timer `unref`ado pelo mesmo motivo de `withAttemptTimeout`. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Desfecho de UMA tentativa.
 *
 *  - `retry: false` — acabou, com o desfecho terminal da releitura.
 *  - `retry: true`  — falha TRANSITÓRIA candidata a nova tentativa. O estado
 *    local não foi tocado (é a invariante do módulo) e nada foi contado ainda:
 *    a série de convergência só recebe o desfecho DEFINITIVO.
 */
type ResyncAttempt =
  | { retry: false; outcome: ResyncOutcome; error?: string }
  | { retry: true; error: string };

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
 *    resolução a ir ao banco. Barato, na direção segura e SEM retry: não
 *    depende de ordenação nem de resposta do Redis, então acontece uma vez, no
 *    começo, e nunca falha.
 *
 * ## Fail-closed, em TODAS as tentativas
 *
 * Se a leitura FALHAR, esta réplica NÃO conclui "não há override": o estado
 * local é preservado (um override em vigor continua em vigor) em toda tentativa
 * e também no esgotamento. Concluir "não há override" a partir de um Redis que
 * não respondeu seria inventar um desligamento do kill switch durante uma falha
 * de Redis — a direção exatamente errada. Chave ilegível (JSON corrompido)
 * segue a mesma regra: não dá para concluir nada dela.
 *
 * ## Retry, e o que é TERMINAL
 *
 * `resync_failed` só sai no ESGOTAMENTO (ver `RESYNC_RETRY`). Tentativa
 * intermediária que falha é distinguível e não polui a série de convergência:
 * ela vira o log `llm_gateway.circuit_override_resync_retry` (WARN, com
 * `attempt` e o erro) e nada mais. Um ponto em
 * `{reason="resync_failed"}` passa a significar "esta réplica tentou 4 vezes e
 * não conseguiu", que é o que o alerta da #534 promete.
 *
 * Nem toda falha é retentável, e a distinção importa:
 *
 *  - **retenta**: `GET` que falhou ou estourou o timeout, `SUBSCRIBE` sem ack,
 *    chave ilegível. São transitórias por natureza (failover, socket voltando).
 *  - **NÃO retenta**: payload PRESENTE e recusado pela governança (sem
 *    `expires_at` absoluto, sem ator, vencido, acima do teto). A recusa é
 *    determinística sobre o conteúdo da chave — retentar daria o mesmo
 *    resultado quatro vezes e escreveria quatro linhas `_rejected` idênticas na
 *    trilha durável, transformando auditoria em ruído. Continua sendo
 *    divergência, e sai como `resync_failed` na hora.
 *  - **não é falha**: `superseded`. Uma mensagem do canal venceu a releitura, e
 *    ela é pelo menos tão nova quanto o que o `GET` leu — inclusive quando
 *    chega ENTRE duas tentativas, que é por isso que a geração é conferida
 *    antes de cada retry.
 *  - **não é falha, e não é convergência**: `aborted`. O subscriber foi fechado
 *    (drain, deploy) no meio da releitura. Ver abaixo.
 *
 * ## Drain: a releitura é CANCELADA, não esperada (achado 2 da #561)
 *
 * Esta cadeia continua NÃO participando da sequência de shutdown. Esperar um
 * `GET` contra um Redis morto travaria o drain — foi o bug que segurou a #512.
 * Com o retry isso PIORARIA: o pior caso é ~10,1s de deadlines e backoffs
 * (`resyncWorstCaseMs()`). Se alguém um dia encadear a releitura no drain, o
 * drain herda esse tempo.
 *
 * O que mudou é a outra ponta. `stopLLMSettingsInvalidationSubscriber()` agora
 * CANCELA a releitura em voo (`SubscriberLifecycle`), e ela termina como
 * `aborted` — desfecho NÃO divergente, fora de `DIVERGENT_OUTCOMES`, com
 * `reason="resync_aborted"` na série. Antes, uma releitura em backoff acordava
 * depois do `quit()`, gastava as tentativas restantes contra um cliente
 * encerrado e saía como `failed`: um drain deliberado paginava
 * (`state="enforce"`) uma réplica que estava apenas saindo. O `unref` dos
 * timers nunca cobriu isso — ele impede segurar o event loop, não impede a
 * emissão enquanto o resto do drain ainda o mantém vivo.
 *
 * Isso NÃO relaxa o fail-closed: uma releitura que falha de verdade continua
 * terminando em `failed`, com o estado local preservado. `aborted` só existe
 * para o caso em que ninguém perguntou nada — o subscriber deixou de existir.
 *
 * A mitigação antiga continua valendo como segunda linha: TODO timer deste
 * caminho (deadline de tentativa e backoff) é `unref`ado, então um retry em voo
 * não segura o event loop sozinho. Não confie só nela se for mudar o desenho:
 * releia a #512 antes.
 */
async function resyncAuthoritativeState(sub: IORedis, life: SubscriberLifecycle): Promise<void> {
  // O subscriber já foi fechado antes de esta releitura sair da fila da
  // `resyncChain` — num flapping durante o drain, a segunda releitura enfileirada
  // cai exatamente aqui. Ainda assim publica UM evento: "um `ready` por
  // releitura, sempre" é a propriedade que permite responder pelo silêncio.
  if (!life.alive) {
    finishResync('aborted', { attempts: 0 });
    return;
  }

  // Settings PRIMEIRO e uma vez só: o autoritativo é o Postgres, então soltar o
  // cache local É a releitura desse canal. Não depende de ack nem de resposta
  // do Redis — fica fora do laço de retry de propósito.
  invalidateModelCache();

  /**
   * Geração no início da releitura INTEIRA — a guarda que atravessa as
   * tentativas. A de dentro de `attemptResync` cobre a mensagem que chega com o
   * `GET` em voo; esta cobre a que chega durante um BACKOFF, quando não há
   * leitura nenhuma em voo para ceder.
   */
  const generationAtStart = overrideGeneration();

  let lastError = 'sem detalhe';
  for (let attempt = 1; attempt <= RESYNC_RETRY.attempts; attempt++) {
    const result = await attemptResync(sub, life);
    if (!result.retry) {
      finishResync(result.outcome, { error: result.error, attempts: attempt });
      return;
    }
    lastError = result.error;

    if (attempt === RESYNC_RETRY.attempts) break;

    const delay = resyncBackoffMs(attempt);
    logger.warn(
      { attempt, of: RESYNC_RETRY.attempts, next_in_ms: delay, err: lastError },
      'llm_gateway.circuit_override_resync_retry',
    );
    // O backoff é a janela mais LONGA da releitura, e era onde um drain pegava
    // a cadeia dormindo: sem o race, a réplica acordava depois do `quit()` e
    // gastava as tentativas restantes contra um cliente encerrado.
    await Promise.race([sleep(delay), life.stopped]);

    if (!life.alive) {
      finishResync('aborted', { attempts: attempt });
      return;
    }

    // Uma mensagem do canal que chegou durante o backoff é pelo menos tão nova
    // quanto qualquer coisa que a próxima tentativa fosse ler: convergiu, e
    // insistir só produziria uma leitura mais velha competindo com ela.
    if (overrideGeneration() !== generationAtStart) {
      finishResync('superseded', { attempts: attempt });
      return;
    }
  }

  finishResync('failed', { error: lastError, attempts: RESYNC_RETRY.attempts });
}

/**
 * UMA tentativa de releitura: re-inscreve (esperando o ack), lê a chave
 * durável e aplica o que ela disser.
 *
 * Não toca no estado local em nenhum caminho de falha, e não conta nada: quem
 * publica na série de convergência é `finishResync`, uma vez por releitura,
 * com o desfecho DEFINITIVO.
 *
 * O `deadline` é UM só para a tentativa inteira (achado 1 da #561): o ack de
 * re-inscrição e o `GET` dividem o mesmo orçamento, então uma tentativa nunca
 * custa mais que `attemptTimeoutMs` por mais lenta que a primeira operação
 * seja. Ver `withAttemptDeadline`.
 */
async function attemptResync(sub: IORedis, life: SubscriberLifecycle): Promise<ResyncAttempt> {
  const deadline = Date.now() + RESYNC_RETRY.attemptTimeoutMs;

  try {
    // Re-inscrever de propósito, mesmo com `autoResubscribe` do ioredis ligado:
    // o `await` no ack é o que dá o MESMO argumento de ordenação do boot (Redis
    // é single-threaded, então um `GET` posterior ao ack não pode perder um
    // `PUBLISH` que venha depois do `SET`). Re-inscrição num canal já inscrito é
    // idempotente no Redis — inclusive quando a tentativa anterior expirou pelo
    // timeout e o ack chegou depois.
    await withAttemptDeadline(
      sub.subscribe(...SUBSCRIBED_CHANNELS),
      'ack de re-inscrição',
      deadline,
      life,
    );
  } catch (err) {
    // Fechamento vem ANTES do log e do retry: uma réplica que está saindo não
    // produz `settings_resubscribe_failed` nem gasta tentativa.
    if (!life.alive) return { retry: false, outcome: 'aborted' };
    logger.warn(
      { err: (err as Error).message, channels: SUBSCRIBED_CHANNELS },
      'llm_gateway.settings_resubscribe_failed',
    );
    /**
     * Sem o ack, o argumento de ordenação que sustenta esta releitura NÃO
     * existe (revisão do dono da #552).
     *
     * Ele é o do boot: com a inscrição confirmada, ou o Redis processa o `SET`
     * antes do nosso `GET` (a chave é encontrada), ou processa o `GET` antes e
     * então o `PUBLISH` — que vem sempre depois do `SET` — é entregue à
     * inscrição já ativa. Sem inscrição ativa some o segundo braço: um
     * `SET` + `PUBLISH` logo depois do `GET` não chega por canal NEM aparece na
     * leitura, e a réplica ficaria com o estado errado achando que convergiu.
     *
     * O caso mais perigoso é tratar AUSÊNCIA de chave como autoritativa nesse
     * estado: limparíamos um override vivo com base numa leitura que não pode
     * ser defendida. Então nem se lê — em NENHUMA tentativa. O que muda com o
     * retry é só que um ack perdido na volta do socket ganha mais três chances
     * antes de virar alerta.
     */
    return {
      retry: true,
      error: `sem ack de re-inscrição (${(err as Error).message}): ordenação GET × PUBLISH não garantida, leitura não realizada`,
    };
  }

  // A geração é capturada ANTES do `GET`: se uma mensagem do canal for aplicada
  // enquanto a resposta está em voo, ela é pelo menos tão nova quanto o que o
  // `GET` leu e a releitura CEDE. Argumento completo em `circuit-mode.ts`,
  // bloco de `generation`.
  const generation = overrideGeneration();
  let raw: string | null;
  try {
    raw = await withAttemptDeadline(
      redis.get(LLM_CIRCUIT_OVERRIDE_KEY),
      'GET da chave do override',
      deadline,
      life,
    );
  } catch (err) {
    if (!life.alive) return { retry: false, outcome: 'aborted' };
    return { retry: true, error: (err as Error).message };
  }

  // O `GET` respondeu, mas o subscriber já não existe: aplicar a postura numa
  // réplica que está saindo só escreveria trilha de auditoria sem ninguém para
  // usá-la. Não é divergência — ninguém mais depende do estado desta réplica.
  if (!life.alive) return { retry: false, outcome: 'aborted' };

  if (overrideGeneration() !== generation) {
    return { retry: false, outcome: 'superseded' };
  }

  if (raw === null) {
    // Ausência é resposta AUTORITATIVA (diferente de erro, acima): a chave
    // expirou ou foi apagada por um `clear` que esta réplica não ouviu.
    if (currentOverride() === null) {
      return { retry: false, outcome: 'noop' };
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
    return { retry: false, outcome: 'cleared' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { retry: true, error: `chave ilegível: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { retry: true, error: 'chave ilegível: payload não é objeto' };
  }

  const result = applyCircuitOverride(parsed as CircuitOverrideMessage, Date.now(), 'resynced');
  // Recusa (validade vencida, payload sem `expires_at` absoluto, sem ator) já é
  // contada e auditada como `rejected` por `applyCircuitOverride`, com
  // `source: 'resynced'` — mas aquela é a série da CONTABILIDADE de override.
  // Nesta, que é a de CONVERGÊNCIA, recusa não é convergir: a réplica não
  // aplicou o estado autoritativo, preservou o dela e pode estar divergente da
  // frota. Ver `DIVERGENT_OUTCOMES`.
  //
  // E é TERMINAL: a recusa é determinística sobre o conteúdo da chave, então
  // retentar escreveria quatro `_rejected` idênticos na trilha durável sem
  // mudar o desfecho. Ver o bloco de retry em `resyncAuthoritativeState`.
  return {
    retry: false,
    outcome: result.applied ? 'applied' : 'rejected',
    error: result.error,
  };
}


type ResyncOutcome =
  | 'applied'
  | 'cleared'
  | 'noop'
  | 'superseded'
  | 'rejected'
  | 'failed'
  | 'aborted';

/**
 * Desfechos em que a réplica NÃO pode afirmar que está consistente com o Redis
 * (revisão do dono da #552).
 *
 *  - `failed`   — não houve leitura defensável: `GET` falhou, chave ilegível,
 *    ou re-inscrição sem ack.
 *  - `rejected` — houve leitura, e o payload PRESENTE foi recusado (sem
 *    `expires_at` absoluto, sem ator, vencido, acima do teto). A réplica
 *    preservou o estado dela e seguiu com uma postura que o Redis não confirma.
 *
 * Os dois pintam a mesma pergunta operacional — "esta réplica pode estar
 * divergente da frota?" — e por isso compartilham `reason="resync_failed"`. A
 * CAUSA continua distinguível: `outcome` no log e a ação `_rejected` com
 * `source='resynced'` na trilha durável.
 *
 * `superseded` está deliberadamente FORA: ali a releitura perdeu para uma
 * mensagem do canal, que é sempre pelo menos tão nova quanto o que o `GET` leu
 * — o estado final É o do Redis. Somar os dois no mesmo balde apagaria a única
 * diferença que importa aqui (convergiu × pode estar divergente) e cegaria o
 * alerta com ruído de corrida normal.
 *
 * `aborted` também está FORA, e por um motivo DIFERENTE (achado 2 da #561): ali
 * a réplica não divergiu nem convergiu — ela está saindo. O subscriber foi
 * fechado pelo drain no meio da releitura, e ninguém mais depende do estado
 * dela. Pôr `aborted` aqui faria todo deploy paginar.
 */
const DIVERGENT_OUTCOMES: ReadonlySet<ResyncOutcome> = new Set<ResyncOutcome>([
  'failed',
  'rejected',
]);

/**
 * Convergência OBSERVÁVEL: um evento por releitura, sempre, mesmo quando ela
 * não muda nada — é o que permite responder "esta réplica ressincronizou depois
 * da queda?" em vez de inferir do silêncio.
 *
 * Fica na família que já existe (`maia_llm_circuit_mode_overrides_total`), com
 * dois valores novos de `reason`: `resynced` (a releitura terminou e o estado
 * local é o do Redis; `state` é a postura que ficou valendo) e `resync_failed`
 * (não deu para afirmar isso; `state` é a postura PRESERVADA, que pode estar
 * divergente da frota). Métrica nova seria uma família a mais respondendo sobre
 * o mesmo controle.
 *
 * `attribute: false` pelo mesmo motivo do resto do módulo: a postura é da
 * frota, e o `tenant_id` que por acaso estava no ALS não diz nada sobre ela.
 *
 * ## Três baldes, não dois (achado 2 da #561)
 *
 * `resync_aborted` é o terceiro valor de `reason` desta família. Ele NÃO pode
 * ser dobrado em nenhum dos outros dois: em `resync_failed` faria todo drain
 * paginar, que é o defeito; em `resynced` afirmaria uma convergência que não
 * houve — a releitura foi interrompida, não concluída, e um gate de promoção
 * que confie em `{reason="resynced"}` estaria lendo evidência verde falsa.
 * Nenhum alerta o seleciona, de propósito: uma réplica saindo não é incidente.
 */
function resyncReason(outcome: ResyncOutcome): 'resynced' | 'resync_failed' | 'resync_aborted' {
  if (outcome === 'aborted') return 'resync_aborted';
  return DIVERGENT_OUTCOMES.has(outcome) ? 'resync_failed' : 'resynced';
}

function finishResync(
  outcome: ResyncOutcome,
  detail: { error?: string; attempts?: number } = {},
): void {
  resyncCount++;
  const state = effectiveMode();
  const divergent = DIVERGENT_OUTCOMES.has(outcome);
  counter(METRIC.LLM_CIRCUIT_MODE_OVERRIDES, { state, reason: resyncReason(outcome) }, 1, {
    attribute: false,
  });
  // `attempts` vai no LOG, nunca em rótulo: a pergunta "gastou quantas
  // tentativas?" é de triagem, não de série temporal, e um rótulo a mais
  // multiplicaria a cardinalidade de uma família que já tem `state` × `reason`.
  const record = {
    outcome,
    state,
    attempts: detail.attempts,
    key: LLM_CIRCUIT_OVERRIDE_KEY,
    err: detail.error,
  };
  if (divergent) {
    // ERROR, não WARN: uma réplica que não conseguiu reler — ou que recusou o
    // que leu — pode estar recusando tráfego que o plantão já mandou parar de
    // recusar, e ninguém a acordou.
    logger.error(record, 'llm_gateway.circuit_override_resync_failed');
    return;
  }
  if (outcome === 'aborted') {
    // Nome de log PRÓPRIO: um `grep circuit_override_resynced` num pós-mortem
    // não pode devolver linhas de releituras que foram canceladas pelo drain.
    logger.warn(record, 'llm_gateway.circuit_override_resync_aborted');
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
  /**
   * Ciclo de vida DESTE subscriber, capturado pelo handler de `ready` abaixo.
   * Cada `start` cria um novo, e as releituras que ele dispara ficam presas a
   * ele: um `stop` só cancela as releituras do subscriber que foi fechado.
   */
  const life = newSubscriberLifecycle();
  subscriberLifecycle = life;
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
    resyncChain = resyncChain.then(() => resyncAuthoritativeState(sub, life));
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
 *
 * ## Cancela a releitura em voo — e NÃO a espera (achado 2 da #561)
 *
 * O `stop` marca o ciclo de vida como morto ANTES de qualquer `await`, então
 * uma releitura em backoff ou com um `GET` pendurado sai na hora, como
 * `aborted`. Sem isso ela acordava depois do `quit()`, gastava as tentativas
 * restantes contra um cliente encerrado e terminava em `resync_failed` — que
 * nesta leva virou alerta, com página em `state="enforce"`. Um drain deliberado
 * não pode acordar o plantão.
 *
 * O que continua valendo: o drain NÃO espera a cadeia. Esperar um `GET` contra
 * um Redis morto travaria a saída — o bug da #512 — e agora o pior caso seria
 * `resyncWorstCaseMs()` (~10,1s) em cima disso. Cancelar é justamente o que
 * torna a espera desnecessária.
 */
export async function stopLLMSettingsInvalidationSubscriber(): Promise<void> {
  subscriberLifecycle?.stop();
  subscriberLifecycle = null;
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
  // Mesmo cancelamento do `stop` de produção: sem ele, uma releitura em retry
  // vaza de um teste para o seguinte e publica nele.
  subscriberLifecycle?.stop();
  subscriberLifecycle = null;
  subscriberStarted = false;
  subscriberReady = Promise.resolve();
  void subscriber?.quit().catch(() => undefined);
  subscriber = null;
}
