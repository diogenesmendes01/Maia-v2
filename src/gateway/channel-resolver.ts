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

  // 3. Miss ou canal desativado: warning + fallback default (não-fatal — gateway
  //    continua processando como legacy, e o owner vê o warning no dashboard).
  if (!channel || !channel.active) {
    logger.warn(
      {
        channel_type: args.channel_type,
        external_id: args.external_id,
        found: !!channel,
        active: channel?.active ?? false,
      },
      'channel_resolver.unknown_or_inactive_channel_fallback',
    );
    return { tenant_id: 'default', agent_id: 'default', channel_id: null };
  }

  // 4. Resolução bem-sucedida — emite o triplete real para o downstream.
  return {
    tenant_id: channel.tenant_id,
    agent_id: channel.agent_id,
    channel_id: channel.id,
  };
}
