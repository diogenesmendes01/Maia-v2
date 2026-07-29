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
import { evaluateLineReadiness } from './line-readiness.js';

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
 * Issue #518 — ATOR administrativo da operação. Quando o pareamento nasce no
 * Admin autenticado, `actor_id`/`actor_role` são o usuário do console (não
 * `system`) e `correlation_id` amarra o pedido do console às transições do
 * runtime. O caminho legado `/setup` (token de operador) não tem ator
 * identificável e omite o bloco — o audit então registra a origem `setup`.
 */
export interface PairingActor {
  actor_id: string;
  actor_role: string;
  correlation_id: string;
}

/**
 * Ganchos de PERSISTÊNCIA fornecidos pelo chamador. `line-pairing` continua
 * sendo pura orquestração em memória: quem tem acesso ao Postgres (o worker
 * `channel_pairing`) injeta a gravação do estado e do material CIFRADO.
 *
 * Manter o DB fora deste módulo é deliberado — o caminho `/setup` legado roda
 * sem repos e os testes unitários da orquestração não precisam de Postgres.
 *
 * `onMaterial` recebe o material EM CLARO e é o ÚNICO ponto autorizado a
 * vê-lo; ele deve cifrar antes de qualquer persistência e nunca logar.
 */
export interface PairingHooks {
  onMaterial?: (
    material: { kind: 'qr'; qr: string } | { kind: 'code'; code: string },
  ) => void;
  onPhase?: (phase: {
    phase: 'pairing' | 'verified' | 'failed';
    reason_code?: string | null;
  }) => void;
}

/** Metadata de auditoria comum: ator + correlação, NUNCA material sensível. */
function actorMetadata(actor: PairingActor | undefined): Record<string, unknown> {
  return actor
    ? {
        actor_id: actor.actor_id,
        actor_role: actor.actor_role,
        correlation_id: actor.correlation_id,
        origin: 'admin_ui',
      }
    : { origin: 'setup_token' };
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
  actor?: PairingActor;
  hooks?: PairingHooks;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const hooks = args.hooks ?? {};
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
      ...actorMetadata(args.actor),
    },
  });
  hooks.onPhase?.({ phase: 'pairing' });

  // A promise resolve no matched/TTL — corre em background; o operador
  // acompanha via channelPairingStatus (polling, mesmo padrão do /setup).
  void getLineSessionManager()
    .startPairingSession({
      channel_id: channel.id,
      declared_line: declared,
      onUpdate: (u) => {
        // Guard de identidade também no material: um callback atrasado de uma
        // sessão abortada não pode reinjetar QR na tentativa NOVA.
        if (!stillCurrent()) return;
        if (u.qr) {
          state.qr = u.qr;
          hooks.onMaterial?.({ kind: 'qr', qr: u.qr });
        }
        if (u.pairing_code) {
          state.pairing_code = u.pairing_code;
          hooks.onMaterial?.({ kind: 'code', code: u.pairing_code });
        }
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
        hooks.onPhase?.({ phase: 'failed', reason_code: reason });
        await auditScoped(channel, {
          acao: reason === 'ttl_expired_or_aborted' ? 'pairing_session_expired' : 'pairing_session_failed',
          metadata: {
            channel_id: channel.id,
            declared_line: declared,
            actual_line: result.actual_line,
            reason,
            ...actorMetadata(args.actor),
          },
        });
        return;
      }
      // Review PR #528 (P1) — a tentativa ainda é a CORRENTE?
      //
      // `abortPairing` só consegue resolver a promise se o `open` ainda não
      // tiver disparado. Se o operador cancelou DURANTE a promoção do auth
      // state, a sessão antiga chegava aqui com `matched: true` e ATIVAVA a
      // linha — o oposto exato do que cancelar significa. O guard de
      // identidade que já protegia o estado em memória passa a proteger
      // também o efeito colateral: sem posse corrente, o auth promovido é
      // destruído e nada é ativado.
      if (!stillCurrent()) {
        await rm(lineAuthDir(channel.id), { recursive: true, force: true }).catch(
          () => undefined,
        );
        logger.warn(
          { channel_id: channel.id },
          'pairing_session.superseded_result_discarded',
        );
        await auditScoped(channel, {
          acao: 'pairing_session_failed',
          metadata: {
            channel_id: channel.id,
            declared_line: declared,
            reason: 'superseded_by_abort_or_retry',
            ...actorMetadata(args.actor),
          },
        });
        return;
      }
      // Issue #518 §4 / review PR #528 (P1) — POSSE PROVADA NÃO É PERMISSÃO
      // DE ROTEAR.
      //
      // A verificação sempre é registrada (a linha é desta workspace, ponto
      // final), mas a ATIVAÇÃO passa por uma revalidação determinística de
      // readiness no backend. Sem este gate, parear a linha de um agente sem
      // política/papel deixava `channels.active = true` e, com
      // `MAIA_MULTI_LINE`, a sessão de roteamento subia na hora — uma linha
      // respondendo sem governança configurada.
      //
      // Não é um beco sem saída: o worker `channel_pairing` revalida as linhas
      // `verified_offline` a cada minuto e ativa assim que a política ficar
      // pronta, sem novo pareamento.
      const readiness = await evaluateLineReadiness({
        id: channel.id,
        tenant_id: channel.tenant_id,
        agent_id: channel.agent_id,
      });
      if (!readiness.ready) {
        if (stillCurrent()) pairings.set(channel.id, { ...IDLE, phase: 'verified' });
        hooks.onPhase?.({ phase: 'verified', reason_code: 'awaiting_readiness' });
        await auditScoped(channel, {
          acao: 'pairing_session_verified',
          metadata: {
            channel_id: channel.id,
            tenant_id: channel.tenant_id,
            agent_id: channel.agent_id,
            line: declared,
            routing_activated: false,
            ...actorMetadata(args.actor),
          },
        });
        await auditScoped(channel, {
          acao: 'channel_activation_deferred',
          metadata: {
            channel_id: channel.id,
            line: declared,
            reason: readiness.reason_code,
            ...actorMetadata(args.actor),
          },
        });
        logger.info(
          { channel_id: channel.id, reason: readiness.reason_code },
          'pairing_session.verified_awaiting_readiness',
        );
        return;
      }
      // Readiness ok — ativa. 23505 do índice global (091) ⇒ a linha já
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
        hooks.onPhase?.({ phase: 'failed', reason_code: act.reason });
        await auditScoped(channel, {
          acao: 'pairing_session_failed',
          metadata: {
            channel_id: channel.id,
            declared_line: declared,
            reason: act.reason,
            ...actorMetadata(args.actor),
          },
        });
        return;
      }
      if (stillCurrent()) pairings.set(channel.id, { ...IDLE, phase: 'verified' });
      hooks.onPhase?.({ phase: 'verified' });
      await auditScoped(channel, {
        acao: 'pairing_session_verified',
        metadata: {
          channel_id: channel.id,
          tenant_id: channel.tenant_id,
          agent_id: channel.agent_id,
          line: declared,
          routing_activated: true,
          ...actorMetadata(args.actor),
        },
      });
      await auditScoped(channel, {
        acao: 'channel_activated',
        metadata: {
          channel_id: channel.id,
          line: declared,
          trigger: 'pairing_verified',
          ...actorMetadata(args.actor),
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
      hooks.onPhase?.({ phase: 'failed', reason_code: 'session_error' });
      await auditScoped(channel, {
        acao: 'pairing_session_failed',
        metadata: {
          channel_id: channel.id,
          declared_line: declared,
          reason: (err as Error).message,
          ...actorMetadata(args.actor),
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
