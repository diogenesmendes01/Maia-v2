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
 */
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { redis } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
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
 * Aplica a invalidação local. Exportado separado do wiring de Redis para que o
 * teste possa exercer o handler sem subir um subscriber.
 */
export function handleLLMSettingsInvalidation(channel: string): void {
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
  sub.on('message', (channel) => handleLLMSettingsInvalidation(channel));
  void sub.subscribe(LLM_SETTINGS_INVALIDATION_CHANNEL, (err) => {
    if (err) {
      // Degradação documentada: sem subscribe, cada réplica ainda converge
      // pelo TTL curto do cache.
      logger.warn(
        { err: err.message, channel: LLM_SETTINGS_INVALIDATION_CHANNEL },
        'llm_gateway.settings_subscribe_failed_natural_ttl_only',
      );
      return;
    }
    logger.info(
      { channel: LLM_SETTINGS_INVALIDATION_CHANNEL },
      'llm_gateway.settings_invalidation_subscriber_started',
    );
  });
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
