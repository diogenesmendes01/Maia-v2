/**
 * P6 Task 5 — Channel resolver (gateway entry point).
 *
 * Resolve (channel_type, external_id) -> (tenant_id, agent_id, channel_id).
 * É o ENTRY POINT: roda ANTES do tenant context existir, portanto usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o
 * applyTenantGuard. Esse é o único momento legítimo de bypass — a partir
 * daqui, o resto do pipeline opera dentro de (tenant, agent).
 *
 * Política de resolução (issue #268 fail-loud + issue #411 single-tenant
 * catch-all):
 *   - Channel encontrado e ativo (exact match)  -> tenant_id/agent_id/channel.id reais.
 *   - Miss/inativo NUM runtime single-tenant     -> (default, default, <default channel id>).
 *   - Miss/inativo NUM deployment multi-tenant   -> throw TypedError('channel_resolution_failed').
 *   - 2+ canais ativos cross-tenant (ambíguo)    -> throw TypedError('channel_resolution_failed').
 *
 * ── Por que o catch-all (issue #411) ──────────────────────────────────────
 * Um canal WhatsApp representa a LINHA DO BOT (o número em que as mensagens
 * chegam), não o remetente. No runtime single-tenant atual, `core.ts` /
 * `baileys.ts` passam o telefone do REMETENTE como `external_id`, que nunca
 * casa com o único canal semeado (`external_id = 'default-channel'`). Antes do
 * #411 esse miss levantava `channel_resolution_failed` → DLQ → o bot parava de
 * responder a TODOS. O catch-all resolve qualquer remetente desconhecido para
 * o canal `default/default` semeado QUANDO o deployment é comprovadamente
 * single-tenant (nenhum canal ativo pertence a um tenant != 'default').
 *
 * ── Por que isso NÃO regride o #268 ───────────────────────────────────────
 * O fallback default/default só é entregue quando `findDefaultCatchAllChannel`
 * confirma que NÃO existe canal ativo de outro tenant. Assim que UM deployment
 * multi-tenant registra um canal real, qualquer miss volta a ser fail-loud
 * (throw), preservando o invariante "Maias de empresas diferentes jamais se
 * misturam" — buckets de rate-limit cross-tenant nunca colapsam no
 * `maia:ratelimit:default:default:*` compartilhado. A ambiguidade (2+ ativos
 * cross-tenant) continua sendo throw, propagado do repo.
 */
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
  resolver_path:
    | 'unknown_or_inactive_channel'
    | 'ambiguous_active_channels';
  /** When `unknown_or_inactive_channel`: did we find a row at all? */
  found?: boolean;
  /** When `unknown_or_inactive_channel`: was the row marked active? */
  active?: boolean;
  /** When `ambiguous_active_channels`: which tenants are conflicting. */
  conflicting_tenant_ids?: string[];
};

export async function resolveChannel(args: {
  channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
  external_id: string;
}): Promise<ChannelResolution> {
  // 1. Lookup cross-tenant (único método autorizado a bypassar tenant guard,
  //    pois aqui ainda não há contexto — estamos justamente descobrindo qual).
  //
  //    [Codex review #277] O repo itera matches preferindo `active=true` e
  //    lança `channel_resolution_failed` (resolver_path: ambiguous_active_channels)
  //    se houver 2+ canais ativos em tenants distintos para o mesmo
  //    (channel_type, external_id). Não capturamos aqui — o try/catch do caller
  //    em `agent/core.ts` já emite o audit padrão.
  const channel = await channelsRepo.findByExternalCrossTenant({
    channel_type: args.channel_type,
    external_id: args.external_id,
  });

  // 2. Exact match ativo → emite o triplete real para o downstream.
  if (channel && channel.active) {
    return {
      tenant_id: channel.tenant_id,
      agent_id: channel.agent_id,
      channel_id: channel.id,
    };
  }

  // 3. Miss ou canal desativado. Issue #411: no runtime single-tenant a linha
  //    do bot é semeada como `default/default` e o `external_id` do lookup é o
  //    telefone do REMETENTE — então o exact match sempre falha. Em vez de
  //    derrubar a mensagem (o bug #411), resolvemos para o canal catch-all
  //    `default/default` SE — e somente se — o deployment é comprovadamente
  //    single-tenant. `findDefaultCatchAllChannel` retorna `multi_tenant:true`
  //    assim que existe QUALQUER canal ativo de outro tenant; nesse caso
  //    caímos no fail-loud do #268 (throw), preservando o isolamento.
  const catchAll = await channelsRepo.findDefaultCatchAllChannel({
    channel_type: args.channel_type,
  });

  if (!catchAll.multi_tenant && catchAll.channel) {
    logger.debug(
      {
        channel_type: args.channel_type,
        resolved_channel_id: catchAll.channel.id,
      },
      'channel_resolver.single_tenant_catch_all',
    );
    return {
      tenant_id: catchAll.channel.tenant_id,
      agent_id: catchAll.channel.agent_id,
      channel_id: catchAll.channel.id,
    };
  }

  // 4. Fail-loud (issue #268). Either a real multi-tenant deployment (an
  //    unknown sender must NOT collapse onto the shared default/default
  //    bucket) or a misconfigured single-tenant runtime where the default
  //    channel seed (migration 035) is missing/inactive. Throw a typed error;
  //    the caller in `agent/core.ts` audits `channel_resolution_failed` and
  //    re-throws (BullMQ retry/DLQ).
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
    catchAll.multi_tenant
      ? 'channel not found or inactive (multi-tenant deployment — refusing default fallback)'
      : 'channel not found or inactive (single-tenant default channel seed missing)',
    details,
  );
}
