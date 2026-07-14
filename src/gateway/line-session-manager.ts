/**
 * LineSessionManager — fases 1–3 do roteamento multi-linha (spec 2026-07-09
 * Draft v4 §1.5/§2.5).
 *
 * Camada de POSSE das sessões Baileys por linha:
 *   - `MAIA_MULTI_LINE=false` (default, fase 1): o manager existe mas fica
 *     desabilitado — a LineOutput usa o transporte global (paridade
 *     byte-a-byte com o runtime atual). A sessão primária ainda se REGISTRA
 *     (observabilidade + shadow), mas nada muda no envio.
 *   - `MAIA_MULTI_LINE=true` (fase 3): envio por canal resolve a sessão da
 *     LINHA daquele canal; sessão indisponível ⇒ TypedError (fail-closed —
 *     NUNCA sai por outra linha). Linhas adicionais sobem para todo canal
 *     whatsapp ativo+verificado, cada uma com auth dir próprio por UUID do
 *     canal (nunca pelo número — path traversal, review v3).
 *   - PairingSession (§2.5): sessão CURTA e dedicada para verificar posse de
 *     um canal DECLARADO (inativo). Nunca roteia inbound; TTL 15min; ao
 *     verificar, promove o auth state para o dir da sessão de roteamento
 *     (rename atômico) e ativa o canal (23505 do índice global ⇒ linha já
 *     pertence a outro workspace).
 *
 * Topologia v1: in-process (N sockets). O corte para processo-por-linha é
 * esta interface — `transportFor` — nada fora dela conhece sockets.
 */
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { mkdirSync, existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { TypedError } from '../lib/utils.js';
import type { WAQuotedContext } from './types.js';
import type { SendPollResult, TypingHandle } from './presence.js';

/** Transporte de UMA linha — mesmo shape das primitivas globais. */
export interface LineTransport {
  sendText(
    jid: string,
    text: string,
    opts?: { quoted?: WAQuotedContext; view_once?: boolean; messageId?: string },
  ): Promise<string | null>;
  sendDocument(
    jid: string,
    path: string,
    opts: { mimetype: string; fileName: string; caption?: string; quoted?: WAQuotedContext },
  ): Promise<string | null>;
  sendVoice(jid: string, buf: Buffer, opts?: { quoted?: WAQuotedContext }): Promise<string | null>;
  sendPoll(
    jid: string,
    question: string,
    options: ReadonlyArray<{ key: string; label: string }>,
  ): Promise<SendPollResult>;
  sendReaction(jid: string, whatsappId: string, emoji: '✅' | '❌'): void;
  startTyping(jid: string, mensagemId: string): TypingHandle;
  markRead(jid: string, whatsappId: string): void;
  isConnected(): boolean;
}

export interface LineSessionInfo {
  channel_id: string;
  line_external_id: string | null;
  state: 'connecting' | 'connected' | 'recovering' | 'closed';
  is_primary: boolean;
}

export function lineAuthDir(channelId: string): string {
  // UUID do canal, nunca o número (review v3 — path traversal). Defesa em
  // profundidade: valida que o resolvido continua sob a raiz.
  const root = pathResolve(config.BAILEYS_AUTH_DIR, 'lines');
  const dir = pathResolve(root, channelId);
  if (!dir.startsWith(root + '/')) {
    throw new TypedError('auth_dir_escape', 'resolved auth dir escapes lines root', {
      channelId,
    });
  }
  return dir;
}

export function pairingAuthDir(channelId: string): string {
  const root = pathResolve(config.BAILEYS_AUTH_DIR, 'pairing');
  const dir = pathResolve(root, channelId);
  if (!dir.startsWith(root + '/')) {
    throw new TypedError('auth_dir_escape', 'resolved pairing dir escapes root', { channelId });
  }
  return dir;
}

const PAIRING_TTL_MS = 15 * 60_000;

export interface PairingResult {
  matched: boolean;
  /** Número real (E.164 com +) reportado pela sessão. */
  actual_line: string | null;
}

class LineSessionManager {
  private transports = new Map<string, LineTransport>();
  private info = new Map<string, LineSessionInfo>();
  private pairingSockets = new Map<string, { sock: WASocket; timer: NodeJS.Timeout }>();

  isEnabled(): boolean {
    return config.MAIA_MULTI_LINE;
  }

  /**
   * Registro da sessão (primária hoje; adicionais na fase 3). Chamado pelo
   * dono do socket (baileys.ts / createLineSession) no connection.open.
   */
  register(
    channelId: string,
    transport: LineTransport,
    meta: { line_external_id: string | null; is_primary: boolean },
  ): void {
    this.transports.set(channelId, transport);
    this.info.set(channelId, {
      channel_id: channelId,
      line_external_id: meta.line_external_id,
      state: 'connected',
      is_primary: meta.is_primary,
    });
    logger.info(
      { channel_id: channelId, line: meta.line_external_id, primary: meta.is_primary },
      'line_session.registered',
    );
  }

  markState(channelId: string, state: LineSessionInfo['state']): void {
    const cur = this.info.get(channelId);
    if (cur) cur.state = state;
    if (state === 'closed') this.transports.delete(channelId);
  }

  /**
   * Fail-closed: sessão da linha indisponível ⇒ erro tipado. NUNCA devolve a
   * sessão de outra linha (responder pela linha errada vaza contexto).
   */
  transportFor(channelId: string): LineTransport {
    const t = this.transports.get(channelId);
    if (!t) {
      throw new TypedError(
        'line_session_unavailable',
        'no live session for this channel line — refusing to send via another line',
        { channel_id: channelId },
      );
    }
    return t;
  }

  listSessions(): LineSessionInfo[] {
    return [...this.info.values()];
  }

  /** Conectividade da LINHA de um canal — nunca lança (probe, não send). */
  isLineConnected(channelId: string): boolean {
    const t = this.transports.get(channelId);
    if (!t) return false;
    if (this.info.get(channelId)?.state !== 'connected') return false;
    return t.isConnected();
  }

  /**
   * §2.5 — PairingSession: verifica posse de um canal DECLARADO. Sobe um
   * socket isolado (auth dir próprio), espera a conexão, compara o número
   * real com `declared_line` e encerra. NÃO roteia inbound (nenhum handler
   * de mensagens é instalado; eventos chegam e morrem aqui — auditado pelo
   * chamador). Ao casar, o auth state é PROMOVIDO para o dir de roteamento.
   *
   * O fluxo interativo (QR/código) é responsabilidade da superfície /setup,
   * que usa os eventos expostos via `onUpdate`.
   */
  async startPairingSession(args: {
    channel_id: string;
    declared_line: string;
    onUpdate?: (u: { qr?: string; pairing_code?: string; state: string }) => void;
    requestPairingCodeFor?: string;
  }): Promise<PairingResult> {
    const dir = pairingAuthDir(args.channel_id);
    mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fallback para a versão da lib */
    }
    const sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
    sock.ev.on('creds.update', saveCreds);

    return new Promise<PairingResult>((resolvePromise) => {
      const timer = setTimeout(() => {
        void this.abortPairing(args.channel_id, 'ttl_expired');
        resolvePromise({ matched: false, actual_line: null });
      }, PAIRING_TTL_MS);
      this.pairingSockets.set(args.channel_id, { sock, timer });

      sock.ev.on('connection.update', (u) => {
        if (u.qr) args.onUpdate?.({ qr: u.qr, state: 'pairing_qr' });
        if (u.connection === 'open') {
          const rawJid = sock.user?.id ?? '';
          const digits = rawJid.split(':')[0]?.split('@')[0] ?? '';
          const actual = digits ? `+${digits.replace(/^\+/, '')}` : null;
          const matched = actual !== null && actual === args.declared_line;
          logger.info(
            { channel_id: args.channel_id, actual, declared: args.declared_line, matched },
            'pairing_session.connected',
          );
          clearTimeout(timer);
          this.pairingSockets.delete(args.channel_id);
          // Encerra o socket de pareamento SEMPRE — a sessão de roteamento
          // (se casou) sobe do dir promovido, nunca deste socket.
          sock.end(undefined);
          void (async () => {
            if (matched) {
              const target = lineAuthDir(args.channel_id);
              mkdirSync(pathResolve(config.BAILEYS_AUTH_DIR, 'lines'), { recursive: true });
              if (existsSync(target)) await rm(target, { recursive: true, force: true });
              await rename(dir, target);
            } else {
              await rm(dir, { recursive: true, force: true });
            }
            resolvePromise({ matched, actual_line: actual });
          })();
        }
      });

      if (args.requestPairingCodeFor) {
        // Código de 8 dígitos (alternativa ao QR).
        void sock
          .requestPairingCode(args.requestPairingCodeFor.replace(/^\+/, ''))
          .then((code) => args.onUpdate?.({ pairing_code: code, state: 'pairing_code' }))
          .catch((err) =>
            logger.warn({ err: (err as Error).message }, 'pairing_session.code_failed'),
          );
      }
    });
  }

  async abortPairing(channelId: string, reason: string): Promise<void> {
    const entry = this.pairingSockets.get(channelId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pairingSockets.delete(channelId);
    try {
      entry.sock.end(undefined);
    } catch {
      /* já fechado */
    }
    await rm(pairingAuthDir(channelId), { recursive: true, force: true });
    logger.info({ channel_id: channelId, reason }, 'pairing_session.aborted');
  }

  /** Test-only. */
  _resetForTests(): void {
    this.transports.clear();
    this.info.clear();
    this.pairingSockets.clear();
  }
}

let managerSingleton: LineSessionManager | null = null;

export function getLineSessionManager(): LineSessionManager {
  if (!managerSingleton) managerSingleton = new LineSessionManager();
  return managerSingleton;
}
