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
import { channelsRepo } from '../db/repositories/channel-repos.js';
import {
  ingressUpsertMessage,
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
};

const sessions = new Map<string, LineSessionState>();

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
      void audit({
        acao: 'line_session_transition',
        metadata: { channel_id: channel.id, state: 'connected', is_primary: false },
      });
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
      void audit({
        acao: 'line_session_transition',
        metadata: { channel_id: channel.id, state: nextState, is_primary: false, reason },
      });
      if (loggedOut || state.stopped) return;
      state.reconnectAttempts += 1;
      if (state.reconnectAttempts > LINE_RECONNECT_MAX_ATTEMPTS) {
        logger.error(
          { channel_id: channel.id, attempts: state.reconnectAttempts },
          'line_session.reconnect_giving_up',
        );
        manager.markState(channel.id, 'closed');
        return;
      }
      const delay = Math.min(
        state.reconnectAttempts * LINE_RECONNECT_BASE_MS,
        LINE_RECONNECT_MAX_MS,
      );
      setTimeout(() => {
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

/** Encerra todas as sessões de linha (shutdown ordenado). */
export async function shutdownLineSessions(): Promise<void> {
  for (const [channelId, state] of sessions) {
    state.stopped = true;
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
