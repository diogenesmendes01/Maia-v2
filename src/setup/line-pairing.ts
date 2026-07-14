/**
 * §2.5 do roteamento multi-linha (spec 2026-07-09 Draft v4) — orquestração do
 * pareamento declarado→verificado de canais whatsapp ADICIONAIS.
 *
 * Fluxo: canal criado DECLARADO (inativo, admin-ui) → operador abre o
 * pareamento aqui (superfície /setup, token) → PairingSession sobe um socket
 * dedicado (auth dir `pairing/<channel_id>/`, TTL 15min, nunca roteia
 * inbound) → número real casa a linha declarada?
 *   - SIM: auth state promovido para `lines/<channel_id>/` + canal ATIVADO
 *     (`activateVerified`; 23505 do índice global ⇒ linha já pertence a outro
 *     workspace — `line_owned_elsewhere`, auth removido).
 *   - NÃO/TTL: auth de pareamento destruído; canal segue declarado.
 *
 * Digitar um número NUNCA dá posse — só a sessão provando ser a linha.
 */
import { rm } from 'node:fs/promises';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { channelsRepo, normalizeWhatsappLine } from '@/db/repositories/channel-repos.js';
import {
  getLineSessionManager,
  lineAuthDir,
} from '@/gateway/line-session-manager.js';

export type ChannelPairingState = {
  phase: 'idle' | 'pairing' | 'verified' | 'failed';
  method?: 'qr' | 'code';
  qr: string | null;
  pairing_code: string | null;
  error: string | null;
  /** Número real reportado pela sessão quando houve mismatch. */
  actual_line: string | null;
};

const IDLE: ChannelPairingState = {
  phase: 'idle',
  qr: null,
  pairing_code: null,
  error: null,
  actual_line: null,
};

const pairings = new Map<string, ChannelPairingState>();

export function channelPairingStatus(channel_id: string): ChannelPairingState {
  return pairings.get(channel_id) ?? IDLE;
}

/**
 * Audita o ciclo de pareamento sob o ALS do (tenant, agent) DONO do canal
 * (review #498 alto 2): sem o wrap, `audit()` caía no bucket `system` —
 * tenant/agente só em metadata não corrige colunas nem labels de métricas.
 */
function auditScoped(
  channel: { tenant_id: string; agent_id: string },
  input: Parameters<typeof audit>[0],
): Promise<void> {
  return runWithTenantContext(
    { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
    () => audit(input),
  );
}

export async function startChannelPairing(args: {
  channel_id: string;
  method: 'qr' | 'code';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const previous = pairings.get(args.channel_id);
  if (previous?.phase === 'pairing') return { ok: false, error: 'pairing_in_progress' };

  // Reserva SÍNCRONA do slot ANTES de qualquer await (review #498 alto 4):
  // com o acesso ao DB entre o teste acima e o set, duas requisições
  // concorrentes passavam ambas e subiam duas PairingSessions para o mesmo
  // canal. Se a validação abaixo falhar, o slot anterior é restaurado.
  const state: ChannelPairingState = {
    phase: 'pairing',
    method: args.method,
    qr: null,
    pairing_code: null,
    error: null,
    actual_line: null,
  };
  pairings.set(args.channel_id, state);
  const releaseReservation = (error: string): { ok: false; error: string } => {
    if (previous) pairings.set(args.channel_id, previous);
    else pairings.delete(args.channel_id);
    return { ok: false, error };
  };
  // Só substitui o estado visível se o slot ainda for DESTA tentativa — um
  // abort do operador (reset para IDLE) ou um pairing novo não podem ser
  // sobrescritos por callbacks atrasados desta sessão.
  const stillCurrent = (): boolean => pairings.get(args.channel_id) === state;

  const channel = await channelsRepo.getByIdCrossTenant(args.channel_id);
  if (!channel) return releaseReservation('channel_not_found');
  if (channel.channel_type !== 'whatsapp') return releaseReservation('not_whatsapp');
  if (channel.active) return releaseReservation('already_active');
  const declared = normalizeWhatsappLine(channel.external_id);
  if (!declared) return releaseReservation('invalid_line');

  await auditScoped(channel, {
    acao: 'pairing_session_started',
    metadata: {
      channel_id: channel.id,
      tenant_id: channel.tenant_id,
      agent_id: channel.agent_id,
      declared_line: declared,
      method: args.method,
    },
  });

  // A promise resolve no matched/TTL — corre em background; o operador
  // acompanha via channelPairingStatus (polling, mesmo padrão do /setup).
  void getLineSessionManager()
    .startPairingSession({
      channel_id: channel.id,
      declared_line: declared,
      onUpdate: (u) => {
        if (u.qr) state.qr = u.qr;
        if (u.pairing_code) state.pairing_code = u.pairing_code;
      },
      ...(args.method === 'code' ? { requestPairingCodeFor: declared } : {}),
    })
    .then(async (result) => {
      if (!result.matched) {
        const reason = result.actual_line ? 'line_mismatch' : 'ttl_expired_or_aborted';
        if (stillCurrent()) {
          pairings.set(channel.id, {
            ...IDLE,
            phase: 'failed',
            error: reason,
            actual_line: result.actual_line,
          });
        }
        await auditScoped(channel, {
          acao: 'pairing_session_failed',
          metadata: {
            channel_id: channel.id,
            declared_line: declared,
            actual_line: result.actual_line,
            reason,
          },
        });
        return;
      }
      // Posse provada — ativa. 23505 do índice global (091) ⇒ a linha já
      // está ativa em OUTRO workspace: fail-closed, remove o auth promovido
      // (mantê-lo permitiria subir uma sessão de linha não-autorizada).
      const act = await channelsRepo.activateVerified({
        tenant_id: channel.tenant_id,
        agent_id: channel.agent_id,
        channel_id: channel.id,
      });
      if (!act.ok) {
        if (stillCurrent()) {
          pairings.set(channel.id, { ...IDLE, phase: 'failed', error: act.reason });
        }
        await rm(lineAuthDir(channel.id), { recursive: true, force: true }).catch(
          () => undefined,
        );
        await auditScoped(channel, {
          acao: 'pairing_session_failed',
          metadata: { channel_id: channel.id, declared_line: declared, reason: act.reason },
        });
        return;
      }
      if (stillCurrent()) pairings.set(channel.id, { ...IDLE, phase: 'verified' });
      await auditScoped(channel, {
        acao: 'pairing_session_verified',
        metadata: {
          channel_id: channel.id,
          tenant_id: channel.tenant_id,
          agent_id: channel.agent_id,
          line: declared,
        },
      });
      // Fase 3: com o runtime multi-linha ligado, a sessão de roteamento da
      // linha recém-verificada sobe imediatamente (sem esperar reboot).
      if (config.MAIA_MULTI_LINE) {
        const { _internal } = await import('@/gateway/line-sessions.js');
        await _internal
          .startLineSession({
            id: channel.id,
            tenant_id: channel.tenant_id,
            agent_id: channel.agent_id,
            external_id: declared,
          })
          .catch((err) =>
            logger.error(
              { channel_id: channel.id, err: (err as Error).message },
              'line_session.start_after_pairing_failed',
            ),
          );
      }
    })
    .catch(async (err) => {
      // Review #498 (alto 4): falhas de filesystem (rm/rename da promoção)
      // agora REJEITAM a promise da PairingSession — este catch encerra o
      // pareamento com `failed` em vez de deixá-lo preso em `pairing`.
      if (stillCurrent()) {
        pairings.set(channel.id, {
          ...IDLE,
          phase: 'failed',
          error: (err as Error).message,
        });
      }
      await auditScoped(channel, {
        acao: 'pairing_session_failed',
        metadata: {
          channel_id: channel.id,
          declared_line: declared,
          reason: (err as Error).message,
        },
      });
    });

  return { ok: true };
}

export async function abortChannelPairing(channel_id: string): Promise<void> {
  // Reset ANTES do abort no manager: abortPairing agora RESOLVE a promise
  // pendente da PairingSession (review #498 alto 4) e o guard de identidade
  // do fluxo acima só preserva o slot se ele já não for mais da tentativa
  // abortada — a UI volta a `idle`, não a `failed`.
  const current = pairings.get(channel_id);
  if (current?.phase === 'pairing') pairings.set(channel_id, { ...IDLE });
  await getLineSessionManager().abortPairing(channel_id, 'operator_abort');
}

/** Test-only. */
export function _resetChannelPairingsForTests(): void {
  pairings.clear();
}
