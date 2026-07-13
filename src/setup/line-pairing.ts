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

export async function startChannelPairing(args: {
  channel_id: string;
  method: 'qr' | 'code';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = pairings.get(args.channel_id);
  if (current?.phase === 'pairing') return { ok: false, error: 'pairing_in_progress' };

  const channel = await channelsRepo.getByIdCrossTenant(args.channel_id);
  if (!channel) return { ok: false, error: 'channel_not_found' };
  if (channel.channel_type !== 'whatsapp') return { ok: false, error: 'not_whatsapp' };
  if (channel.active) return { ok: false, error: 'already_active' };
  const declared = normalizeWhatsappLine(channel.external_id);
  if (!declared) return { ok: false, error: 'invalid_line' };

  const state: ChannelPairingState = {
    phase: 'pairing',
    method: args.method,
    qr: null,
    pairing_code: null,
    error: null,
    actual_line: null,
  };
  pairings.set(channel.id, state);
  await audit({
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
        pairings.set(channel.id, {
          ...IDLE,
          phase: 'failed',
          error: reason,
          actual_line: result.actual_line,
        });
        await audit({
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
        pairings.set(channel.id, { ...IDLE, phase: 'failed', error: act.reason });
        await rm(lineAuthDir(channel.id), { recursive: true, force: true }).catch(
          () => undefined,
        );
        await audit({
          acao: 'pairing_session_failed',
          metadata: { channel_id: channel.id, declared_line: declared, reason: act.reason },
        });
        return;
      }
      pairings.set(channel.id, { ...IDLE, phase: 'verified' });
      await audit({
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
      pairings.set(channel.id, {
        ...IDLE,
        phase: 'failed',
        error: (err as Error).message,
      });
      await audit({
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
  await getLineSessionManager().abortPairing(channel_id, 'operator_abort');
  const current = pairings.get(channel_id);
  if (current?.phase === 'pairing') pairings.set(channel_id, { ...IDLE });
}

/** Test-only. */
export function _resetChannelPairingsForTests(): void {
  pairings.clear();
}
