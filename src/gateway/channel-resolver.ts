/**
 * P6 Task 5 — Channel resolver (gateway entry point).
 *
 * Resolve (channel_type, external_id) -> (tenant_id, agent_id, channel_id).
 * É o ENTRY POINT: roda ANTES do tenant context existir, portanto usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o
 * applyTenantGuard. Esse é o único momento legítimo de bypass — a partir
 * daqui, o resto do pipeline opera dentro de (tenant, agent).
 *
 * Política de fallback:
 *   - Flag MULTI_CHANNEL OFF                 -> default/default/null (legacy mode).
 *   - Channel não encontrado OU inativo      -> default/default/null + warning.
 *   - Channel encontrado e ativo             -> tenant_id/agent_id/channel.id reais.
 *
 * Importante: o fallback NUNCA "adivinha" um tenant — sempre cai em "default",
 * mantendo o isolamento entre tenants inviolável (Maias de empresas diferentes
 * jamais se misturam, mesmo num miss de resolver).
 */
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { channelsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';

export type ChannelResolution = {
  tenant_id: string;
  agent_id: string;
  channel_id: string | null;
};

/**
 * [P88-M5] Sampled warning state for resolver misses.
 *
 * A scanner/spammer probing random external_ids would fill the log at
 * one-line-per-message. We log the FIRST miss per `(channel_type, external_id)`
 * pair, then suppress until a 5-minute window elapses or a count threshold
 * is hit — whichever comes first. This preserves the alerting signal for
 * legitimately-misconfigured channels without drowning the log on abuse.
 *
 * Map is in-memory per process. With high-volume distinct-id attacks the map
 * itself could grow — bounded by a soft cap (1024 entries) with LRU eviction
 * of the oldest entry on overflow. Acceptable for warn-level signal.
 */
const MISS_WINDOW_MS = 5 * 60 * 1000;
const MISS_COUNT_FLUSH = 50;
const MISS_MAP_CAP = 1024;
type MissState = { count: number; first_logged_at: number };
const missState = new Map<string, MissState>();

function shouldLogMiss(channel_type: string, external_id: string): {
  log: boolean;
  suppressed_count: number;
} {
  const key = `${channel_type}::${external_id}`;
  const now = Date.now();
  const entry = missState.get(key);
  if (!entry) {
    if (missState.size >= MISS_MAP_CAP) {
      // LRU-ish: drop the oldest insertion (Map preserves insertion order).
      const oldest = missState.keys().next().value;
      if (oldest !== undefined) missState.delete(oldest);
    }
    missState.set(key, { count: 1, first_logged_at: now });
    return { log: true, suppressed_count: 0 };
  }
  entry.count += 1;
  const windowElapsed = now - entry.first_logged_at >= MISS_WINDOW_MS;
  const countFlush = entry.count >= MISS_COUNT_FLUSH;
  if (windowElapsed || countFlush) {
    const suppressed = entry.count - 1;
    entry.first_logged_at = now;
    entry.count = 1;
    return { log: true, suppressed_count: suppressed };
  }
  return { log: false, suppressed_count: 0 };
}

export async function resolveChannel(args: {
  channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
  external_id: string;
}): Promise<ChannelResolution> {
  // 1. Flag OFF: modo legacy — todo tráfego cai em default/default sem consultar
  //    o repo (evita custo de query e mantém retro-compat com P0..P5).
  if (!featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) {
    return { tenant_id: 'default', agent_id: 'default', channel_id: null };
  }

  // 2. Lookup cross-tenant (único método autorizado a bypassar tenant guard,
  //    pois aqui ainda não há contexto — estamos justamente descobrindo qual).
  const channel = await channelsRepo.findByExternalCrossTenant({
    channel_type: args.channel_type,
    external_id: args.external_id,
  });

  // 3. Miss ou canal desativado: warning sampled + fallback default (não-fatal —
  //    gateway continua processando como legacy, e o owner vê o warning no
  //    dashboard). [P88-M5] sampling evita flood quando scanner/spammer bate
  //    em external_ids aleatórios — primeira ocorrência loga, repetições
  //    são contadas e flushed a cada 5min ou 50 hits.
  if (!channel || !channel.active) {
    const sample = shouldLogMiss(args.channel_type, args.external_id);
    if (sample.log) {
      logger.warn(
        {
          channel_type: args.channel_type,
          external_id: args.external_id,
          found: !!channel,
          active: channel?.active ?? false,
          suppressed_since_last: sample.suppressed_count,
        },
        'channel_resolver.unknown_or_inactive_channel_fallback',
      );
    }
    return { tenant_id: 'default', agent_id: 'default', channel_id: null };
  }

  // 4. Resolução bem-sucedida — emite o triplete real para o downstream.
  return {
    tenant_id: channel.tenant_id,
    agent_id: channel.agent_id,
    channel_id: channel.id,
  };
}
