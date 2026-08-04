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
 *     postura do contrato.
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
import {
  LLM_CIRCUIT_OVERRIDE_CHANNEL,
  LLM_CIRCUIT_OVERRIDE_KEY,
  applyCircuitOverride,
  handleCircuitOverrideMessage,
} from './circuit-mode.js';
import type { CircuitOverrideMessage } from './circuit-mode.js';
import { invalidateModelCache } from './model-resolver.js';

export const LLM_SETTINGS_INVALIDATION_CHANNEL = 'maia:llm:settings:invalidate';

let subscriberStarted = false;
let subscriber: IORedis | null = null;

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
 * Falha de Redis é propagada (diferente da invalidação de settings, que é
 * best-effort): quem virou o kill switch precisa saber que ele NÃO virou. Um
 * "ok" mentiroso durante incidente é pior que um erro.
 */
export async function publishCircuitOverride(msg: CircuitOverrideMessage): Promise<void> {
  const payload = JSON.stringify(msg);
  const ttl =
    typeof msg.expires_at === 'number' ? Math.max(1, msg.expires_at - Date.now()) : undefined;
  if (msg.clear === true) await redis.del(LLM_CIRCUIT_OVERRIDE_KEY);
  else if (ttl !== undefined) await redis.set(LLM_CIRCUIT_OVERRIDE_KEY, payload, 'PX', ttl);
  else await redis.set(LLM_CIRCUIT_OVERRIDE_KEY, payload);
  await redis.publish(LLM_CIRCUIT_OVERRIDE_CHANNEL, payload);
}

/**
 * Adota um override que já estava em vigor quando esta réplica subiu.
 *
 * Sem isto, um deploy ou um scale-out no meio do incidente traria réplicas
 * novas com o disjuntor de volta na postura do contrato — metade da frota
 * recusando e metade não, que é o pior dos dois mundos. Best-effort: sem Redis,
 * a réplica simplesmente fica na postura versionada.
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

/** Idempotente: chamar mais de uma vez não abre conexões extras. */
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
  void sub.subscribe(LLM_SETTINGS_INVALIDATION_CHANNEL, LLM_CIRCUIT_OVERRIDE_CHANNEL, (err) => {
    if (err) {
      // Degradação documentada: sem subscribe, cada réplica ainda converge
      // pelo TTL curto do cache — e o kill switch do disjuntor cai na segunda
      // alavanca (`LLM_CIRCUIT_MODE=off` + restart), como o runbook manda.
      logger.warn(
        {
          err: err.message,
          channels: [LLM_SETTINGS_INVALIDATION_CHANNEL, LLM_CIRCUIT_OVERRIDE_CHANNEL],
        },
        'llm_gateway.settings_subscribe_failed_natural_ttl_only',
      );
      return;
    }
    logger.info(
      { channels: [LLM_SETTINGS_INVALIDATION_CHANNEL, LLM_CIRCUIT_OVERRIDE_CHANNEL] },
      'llm_gateway.settings_invalidation_subscriber_started',
    );
  });
  // Depois do subscribe, nunca antes: assim não há janela em que um override
  // publicado logo após o `GET` passe despercebido.
  void adoptPersistedOverride();
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
  void subscriber?.quit().catch(() => undefined);
  subscriber = null;
}
