/**
 * Fase 3 do roteamento multi-linha (spec 2026-07-09 Draft v4 §1.5) — sessões
 * de ROTEAMENTO por linha adicional.
 *
 * Com `MAIA_MULTI_LINE=true`, cada canal whatsapp ATIVO cuja linha não é a da
 * sessão primária sobe um socket próprio:
 *   - auth state em `lines/<channel_id>/` (UUID do canal — nunca o número;
 *     promovido pela PairingSession no pareamento, §2.5);
 *   - inbound roteado pela MESMA pipeline (`ingressUpsertMessage`) com a
 *     linha DESTA sessão como `bot_line_external_id` — o exact-match resolve
 *     o canal certo nos modos exact_first/strict;
 *   - transporte registrado no LineSessionManager — a LineOutput passa a
 *     enviar pela sessão da linha (fail-closed quando ela cai);
 *   - reconexão per-sessão com backoff limitado; loggedOut encerra a posse
 *     (o canal precisa ser re-pareado).
 *
 * Topologia v1: in-process. O corte para processo-por-linha é a interface
 * `LineTransport` — nada fora dela conhece estes sockets.
 */
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { existsSync } from 'node:fs';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { audit } from '../governance/audit.js';
import { runWithTenantContext } from '../db/tenant-context.js';
import { channelsRepo } from '../db/repositories/channel-repos.js';
import {
  channelLineStateRepo,
  type LineState,
} from '../db/repositories/channel-line-state-repos.js';
import {
  ingressUpsertMessage,
  handleMessagesUpdate,
  getCurrentLineE164,
  sendOutboundTextVia,
  sendOutboundDocumentVia,
  sendOutboundVoiceVia,
} from './baileys.js';
import {
  markReadVia,
  startTypingVia,
  sendReactionVia,
  sendPollVia,
} from './presence.js';
import {
  getLineSessionManager,
  lineAuthDir,
  type LineTransport,
} from './line-session-manager.js';
import { triggerRecovery } from '../setup/recovery.js';

const LINE_RECONNECT_BASE_MS = 1000;
const LINE_RECONNECT_MAX_MS = 30_000;
const LINE_RECONNECT_MAX_ATTEMPTS = 5;

type LineChannel = {
  id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
};

type LineSessionState = {
  sock: WASocket | null;
  connected: boolean;
  reconnectAttempts: number;
  stopped: boolean;
  /**
   * Timer de reconexão PENDENTE (review #498 alto 3): rastreado para que
   * `shutdownLineSessions` cancele — sem isso o callback sobrevivia ao
   * shutdown e reabria o socket com um estado novo (`stopped=false`).
   */
  reconnectTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, LineSessionState>();

/**
 * Audita transições da sessão sob o ALS do (tenant, agent) DONO do canal
 * (review #498 alto 2): sem o wrap, `audit()` caía no bucket `system` —
 * metadata não corrige colunas nem labels de métricas.
 */
function auditLineTransition(
  channel: LineChannel,
  metadata: Record<string, unknown>,
): Promise<void> {
  return runWithTenantContext(
    { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
    () => audit({ acao: 'line_session_transition', metadata }),
  );
}

/**
 * Issue #518 — a transição de sessão também PERSISTE (migration 103), para
 * que o console mostre conectado/recovering/deslogado sem depender de estado
 * em memória de outro processo. Best-effort e fail-isolated: a sessão de
 * WhatsApp nunca cai porque o Postgres piscou. Nenhum material sensível é
 * gravado aqui — só o estado e um reason code sanitizado.
 */
function persistLineState(
  channel: LineChannel,
  session: LineSessionState,
  state: LineState,
  extra: { reason_code?: string | null; connected?: boolean } = {},
): void {
  // Review PR #528 (P1) — guard de IDENTIDADE, o mesmo padrão do pareamento.
  // Um `connection.update` atrasado do socket que acabou de ser encerrado
  // gravava `connected` DEPOIS de o operador desabilitar a linha, e a tela
  // voltava a dizer que ela estava no ar. Só escreve quem ainda é a sessão
  // corrente deste canal e não foi parada.
  if (session.stopped || sessions.get(channel.id) !== session) return;
  const now = new Date();
  void channelLineStateRepo
    .upsertTransition({
      channel_id: channel.id,
      tenant_id: channel.tenant_id,
      agent_id: channel.agent_id,
      state,
      reason_code: extra.reason_code ?? null,
      ...(extra.connected ? { connected_at: now } : { disconnected_at: now }),
    })
    .catch((err) =>
      logger.warn(
        { channel_id: channel.id, state, err: (err as Error).message },
        'line_session.state_persist_failed',
      ),
    );
}

/**
 * Cap. 7 (auditoria P0) — LoggedOut de uma linha ADICIONAL encerra a posse
 * DE VERDADE, não só em memória:
 *  1. audita `pairing_logged_out` sob o ALS do dono do canal (mesmo evento
 *     que a primária emite em baileys.ts, com o canal em metadata);
 *  2. delega ao recovery por-alvo, que DESATIVA o canal no DB (fail-closed:
 *     roteamento e boot param de usar a linha — antes a row podia continuar
 *     ativa/elegível) e remove APENAS `lines/<channel_id>` (guard de raiz).
 * O pairing dir NÃO é tocado: fora de um pareamento em curso ele não existe
 * (o ciclo §2.5 promove ou destrói), e removê-lo aqui poderia atropelar um
 * re-pareamento concorrente do operador.
 */
async function handleLineLoggedOut(
  channel: LineChannel,
  reason: number | undefined,
): Promise<void> {
  try {
    await runWithTenantContext(
      { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
      () =>
        audit({
          acao: 'pairing_logged_out',
          metadata: {
            channel_id: channel.id,
            line_external_id: channel.external_id,
            is_primary: false,
            reason,
          },
        }),
    );
    await triggerRecovery({ target: 'line', channel });
  } catch (err) {
    logger.error(
      { channel_id: channel.id, err: (err as Error).message },
      'line_session.logged_out_recovery_failed',
    );
  }
}

function buildTransport(state: LineSessionState): LineTransport {
  const live = (): WASocket | null => (state.connected && state.sock ? state.sock : null);
  return {
    async sendText(jid, text, opts) {
      const sock = live();
      if (!sock) return null;
      return sendOutboundTextVia(sock, jid, text, opts);
    },
    async sendDocument(jid, path, opts) {
      const sock = live();
      if (!sock) return null;
      return sendOutboundDocumentVia(sock, jid, path, opts);
    },
    async sendVoice(jid, buf, opts) {
      const sock = live();
      if (!sock) return null;
      return sendOutboundVoiceVia(sock, jid, buf, opts);
    },
    async sendPoll(jid, question, options) {
      const sock = live();
      if (!sock) return { whatsapp_id: null, message_secret: null, creator_jid: null };
      return sendPollVia(sock, jid, question, options);
    },
    sendReaction(jid, whatsappId, emoji) {
      const sock = live();
      if (sock) sendReactionVia(sock, jid, whatsappId, emoji);
    },
    startTyping(jid, mensagemId) {
      const sock = live();
      if (!sock) return { stop: () => undefined };
      return startTypingVia(sock, jid, mensagemId);
    },
    markRead(jid, whatsappId) {
      const sock = live();
      if (sock) markReadVia(sock, jid, whatsappId);
    },
    isConnected() {
      return state.connected;
    },
  };
}

/** LID→PN resolver do PRÓPRIO socket da linha (mesma semântica do global). */
function lidResolverFor(state: LineSessionState) {
  return async (lid: string): Promise<string | null> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (state.sock as any)?.signalRepository?.lidMapping;
    if (!store || typeof store.getPNForLID !== 'function') return null;
    try {
      const pn = await store.getPNForLID(lid);
      return typeof pn === 'string' && pn.length > 0 ? pn : null;
    } catch {
      return null;
    }
  };
}

async function startLineSession(channel: LineChannel): Promise<void> {
  const dir = lineAuthDir(channel.id);
  if (!existsSync(dir)) {
    // Sem auth state promovido não há posse — o canal precisa passar pela
    // PairingSession (§2.5). Fail-closed: NUNCA subimos uma sessão "vazia"
    // que gere QR fora do fluxo de pareamento.
    logger.warn(
      { channel_id: channel.id, line: channel.external_id },
      'line_session.auth_state_missing_pair_first',
    );
    return;
  }

  const state: LineSessionState = sessions.get(channel.id) ?? {
    sock: null,
    connected: false,
    reconnectAttempts: 0,
    stopped: false,
    reconnectTimer: null,
  };
  sessions.set(channel.id, state);

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    /* fallback para a versão da lib */
  }
  const sock = makeWASocket({ auth: authState, version, printQRInTerminal: false });
  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  const manager = getLineSessionManager();
  const transport = buildTransport(state);
  const lineCtx = {
    botLineE164: channel.external_id,
    lidPhoneResolver: lidResolverFor(state),
    markRead: transport.markRead.bind(transport),
  };

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      await ingressUpsertMessage(msg, lineCtx);
    }
  });

  // Review PR #496 (crítico 1): edits/revokes chegam por CADA sessão — sem
  // este listener as linhas adicionais silenciariam messages.update; o
  // handler compartilhado escopa o lookup pelo canal DESTA sessão.
  sock.ev.on('messages.update', (updates) => {
    void handleMessagesUpdate(updates, channel.id);
  });

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      state.connected = true;
      state.reconnectAttempts = 0;
      manager.register(channel.id, transport, {
        line_external_id: channel.external_id,
        is_primary: false,
      });
      logger.info(
        { channel_id: channel.id, line: channel.external_id },
        'line_session.connected',
      );
      void auditLineTransition(channel, {
        channel_id: channel.id,
        state: 'connected',
        is_primary: false,
      });
      persistLineState(channel, state, 'connected', { connected: true });
      return;
    }
    if (u.connection === 'close') {
      state.connected = false;
      const reason = (u.lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = reason === DisconnectReason.loggedOut;
      const nextState = loggedOut ? ('closed' as const) : ('recovering' as const);
      manager.markState(channel.id, nextState);
      logger.warn(
        { channel_id: channel.id, reason, state: nextState },
        'line_session.closed',
      );
      void auditLineTransition(channel, {
        channel_id: channel.id,
        state: nextState,
        is_primary: false,
        reason,
      });
      // `closed` por loggedOut é PERDA DE POSSE (a linha precisa re-parear);
      // `closed` por desistir da reconexão é `failed` (retryable). Os dois
      // são estados distintos para o operador — a UI oferece CTAs diferentes.
      persistLineState(channel, state, loggedOut ? 'logged_out' : 'recovering', {
        reason_code: loggedOut ? 'whatsapp_logged_out' : 'transport_closed',
      });
      // Cap. 7 — loggedOut persiste o encerramento da posse (canal inativo +
      // rm do auth SÓ desta linha) em vez de fechar apenas em memória.
      if (loggedOut) void handleLineLoggedOut(channel, reason);
      if (loggedOut || state.stopped) return;
      state.reconnectAttempts += 1;
      if (state.reconnectAttempts > LINE_RECONNECT_MAX_ATTEMPTS) {
        logger.error(
          { channel_id: channel.id, attempts: state.reconnectAttempts },
          'line_session.reconnect_giving_up',
        );
        manager.markState(channel.id, 'closed');
        persistLineState(channel, state, 'failed', { reason_code: 'reconnect_exhausted' });
        return;
      }
      const delay = Math.min(
        state.reconnectAttempts * LINE_RECONNECT_BASE_MS,
        LINE_RECONNECT_MAX_MS,
      );
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        // Review #498 (alto 3): o shutdown pode ter marcado o estado entre o
        // agendamento e o disparo — re-checa antes de reabrir o socket.
        if (state.stopped) return;
        startLineSession(channel).catch((err) =>
          logger.error(
            { channel_id: channel.id, err: (err as Error).message },
            'line_session.reconnect_failed',
          ),
        );
      }, delay);
    }
  });
}

/**
 * Boot das linhas adicionais (fase 3). No-op com `MAIA_MULTI_LINE=false`.
 * A linha da sessão primária é pulada (já registrada por baileys.ts);
 * fail-isolated por linha — uma falha não impede as demais.
 */
export async function startAdditionalLineSessions(): Promise<void> {
  if (!config.MAIA_MULTI_LINE) return;
  const lines = await channelsRepo.listActiveWhatsappLinesCrossTenant();
  const primary = getCurrentLineE164();
  for (const line of lines) {
    if (primary && line.external_id === primary) continue;
    try {
      await startLineSession(line);
    } catch (err) {
      logger.error(
        { channel_id: line.id, err: (err as Error).message },
        'line_session.start_failed',
      );
    }
  }
}

/**
 * Issue #518 / review PR #528 (P1) — encerra a sessão de UMA linha.
 *
 * `disable` e `requestRepair` mexiam só no banco: desativavam o registro e
 * (no repair) apagavam o auth dir, mas o SOCKET continuava vivo. Uma linha
 * "desabilitada" seguia registrada no transporte, os timers de reconexão
 * continuavam disparando, `connection.update` atrasado regravava `connected`,
 * e o Baileys podia recriar credenciais em cima do dir recém-apagado ou
 * coexistir com a tentativa de pareamento nova.
 *
 * A ordem aqui é o contrato: marcar como parada (para os callbacks pararem de
 * escrever) → cancelar o timer de reconexão → encerrar o socket → remover o
 * transporte. Só DEPOIS o chamador desativa ou apaga o auth dir.
 *
 * Idempotente: parar uma linha que não tem sessão é um no-op.
 */
export function stopLineSession(channelId: string): boolean {
  const state = sessions.get(channelId);
  // `markState('closed')` remove o transporte no manager mesmo sem sessão
  // local — a linha pode ter sido registrada por outro caminho.
  getLineSessionManager().markState(channelId, 'closed');
  if (!state) return false;
  state.stopped = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.connected = false;
  try {
    state.sock?.end(undefined);
  } catch {
    /* já fechado */
  }
  sessions.delete(channelId);
  logger.info({ channel_id: channelId }, 'line_session.stopped');
  return true;
}

/**
 * Encerra todas as sessões de linha (shutdown ordenado). Cancela os timers
 * de reconexão pendentes (review #498 alto 3) — sem isso um callback
 * agendado antes do shutdown recriava o estado (`stopped=false`) e reabria
 * o socket durante o desligamento.
 */
export async function shutdownLineSessions(): Promise<void> {
  for (const [channelId, state] of sessions) {
    state.stopped = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    try {
      state.sock?.end(undefined);
    } catch {
      /* já fechado */
    }
    getLineSessionManager().markState(channelId, 'closed');
  }
  sessions.clear();
}

/** Test-only. */
export const _internal = { sessions, buildTransport, startLineSession };
