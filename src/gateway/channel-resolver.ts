/**
 * P6 Task 5 — Channel resolver (gateway entry point).
 *
 * Resolve (channel_type, external_id) -> (tenant_id, agent_id, channel_id).
 * É o ENTRY POINT: roda ANTES do tenant context existir, portanto usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o
 * applyTenantGuard. Esse é o único momento legítimo de bypass — a partir
 * daqui, o resto do pipeline opera dentro de (tenant, agent).
 *
 * Política de resolução (issue #268 — fail-loud):
 *   - Flag MULTI_CHANNEL OFF                 -> throw TypedError('channel_resolution_failed').
 *   - Channel não encontrado OU inativo      -> throw TypedError('channel_resolution_failed').
 *   - Channel encontrado e ativo             -> tenant_id/agent_id/channel.id reais.
 *
 * Antes (legacy): qualquer miss caía em `default/default/null`. Isso colapsava
 * buckets de rate-limit entre tenants distintos (cross-tenant DoS — issue #268).
 * Agora o resolver levanta erro tipado; o caller registra audit e deixa o erro
 * propagar (BullMQ retry/DLQ), preservando o invariante "Maias de empresas
 * diferentes jamais se misturam".
 *
 * Para o modo legacy single-tenant, o caller (agent/core.ts) checa a flag
 * MULTI_CHANNEL ANTES de invocar resolveChannel; quando OFF, opera direto
 * em `default/default` sem passar pelo resolver. O throw aqui é uma defesa
 * em profundidade contra callers que pulem essa checagem.
 */
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { channelsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';

export type ChannelResolution = {
  tenant_id: string;
  agent_id: string;
  channel_id: string | null;
};

export type ChannelResolutionFailureContext = {
  channel_type: string;
  external_id: string;
  /** Which fallback branch tripped — useful for audit/triage. */
  resolver_path: 'legacy_flag_off' | 'unknown_or_inactive_channel';
  /** When `unknown_or_inactive_channel`: did we find a row at all? */
  found?: boolean;
  /** When `unknown_or_inactive_channel`: was the row marked active? */
  active?: boolean;
};

export async function resolveChannel(args: {
  channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
  external_id: string;
}): Promise<ChannelResolution> {
  // 1. Flag OFF: previously returned default/default/null (legacy mode).
  //    Issue #268: throw instead. Callers in multi-tenant prod MUST check the
  //    flag before invoking resolveChannel; reaching this branch with the flag
  //    OFF is a programmer error / misconfiguration. Surfacing it loudly
  //    prevents accidental fallback to a shared bucket.
  if (!featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) {
    const details: ChannelResolutionFailureContext = {
      channel_type: args.channel_type,
      external_id: args.external_id,
      resolver_path: 'legacy_flag_off',
    };
    logger.warn(details, 'channel_resolver.legacy_flag_off_throw');
    throw new TypedError(
      'channel_resolution_failed',
      'channel resolver invoked with MULTI_CHANNEL flag OFF',
      details,
    );
  }

  // 2. Lookup cross-tenant (único método autorizado a bypassar tenant guard,
  //    pois aqui ainda não há contexto — estamos justamente descobrindo qual).
  const channel = await channelsRepo.findByExternalCrossTenant({
    channel_type: args.channel_type,
    external_id: args.external_id,
  });

  // 3. Miss ou canal desativado: throw em vez de retornar default. Issue #268
  //    eliminou esse fallback porque ele colapsava buckets de rate-limit entre
  //    tenants distintos (todos os "miss" caíam na mesma key
  //    `maia:ratelimit:default:default:*` — cross-tenant DoS).
  if (!channel || !channel.active) {
    const details: ChannelResolutionFailureContext = {
      channel_type: args.channel_type,
      external_id: args.external_id,
      resolver_path: 'unknown_or_inactive_channel',
      found: !!channel,
      active: channel?.active ?? false,
    };
    logger.warn(details, 'channel_resolver.unknown_or_inactive_channel_throw');
    throw new TypedError(
      'channel_resolution_failed',
      'channel not found or inactive',
      details,
    );
  }

  // 4. Resolução bem-sucedida — emite o triplete real para o downstream.
  return {
    tenant_id: channel.tenant_id,
    agent_id: channel.agent_id,
    channel_id: channel.id,
  };
}
