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
import nodePath, { resolve as pathResolve } from 'node:path';
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

/** Subconjunto de `node:path` usado na validação — injetável para testar
 * as semânticas win32 E posix na mesma plataforma (review #498 médio 5). */
type PathImpl = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Resolve `<base>/<bucket>/<channelId>` garantindo que o resultado é um
 * FILHO DIRETO da raiz do bucket (UUID do canal, nunca o número — review v3,
 * path traversal). Review #498 (médio 5): a comparação por prefixo
 * `startsWith(root + '/')` rejeitava TODO path válido no Windows (o
 * separador de `path.resolve` lá é `\`) — `path.relative` + `path.sep` são
 * portáveis: escape ⇒ `..`/absoluto; descida além de um nível ⇒ contém sep.
 */
export function resolveScopedAuthDir(
  baseDir: string,
  bucket: 'lines' | 'pairing',
  channelId: string,
  p: PathImpl = nodePath,
): string {
  const root = p.resolve(baseDir, bucket);
  const dir = p.resolve(root, channelId);
  const rel = p.relative(root, dir);
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel) || rel.includes(p.sep)) {
    throw new TypedError('auth_dir_escape', `resolved auth dir escapes ${bucket} root`, {
      channelId,
    });
  }
  return dir;
}

export function lineAuthDir(channelId: string): string {
  return resolveScopedAuthDir(config.BAILEYS_AUTH_DIR, 'lines', channelId);
}

export function pairingAuthDir(channelId: string): string {
  return resolveScopedAuthDir(config.BAILEYS_AUTH_DIR, 'pairing', channelId);
}

const PAIRING_TTL_MS = 15 * 60_000;

export interface PairingResult {
  matched: boolean;
  /** Número real (E.164 com +) reportado pela sessão. */
  actual_line: string | null;
}

/**
 * Entrada de UMA PairingSession em curso. Criada SINCRONAMENTE na entrada de
 * `startPairingSession` (review #498 alto 4 — a reserva antes de qualquer
 * await impede duas sessões concorrentes de compartilharem o auth dir), por
 * isso `sock`/`timer` são preenchidos depois. `settle` resolve a promise
 * externa exatamente uma vez — o abort também a resolve (nunca fica pendente).
 */
type PairingEntry = {
  sock: WASocket | null;
  timer: NodeJS.Timeout | null;
  settle: ((r: PairingResult) => void) | null;
};

class LineSessionManager {
  private transports = new Map<string, LineTransport>();
  private info = new Map<string, LineSessionInfo>();
  private pairingSockets = new Map<string, PairingEntry>();

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
    // Review #498 (alto 4): UMA PairingSession por canal, mesmo sob chamadas
    // concorrentes — a reserva é síncrona (antes de qualquer await); sem ela,
    // duas sessões compartilhavam o mesmo auth dir.
    if (this.pairingSockets.has(args.channel_id)) {
      throw new TypedError(
        'pairing_in_progress',
        'a pairing session is already running for this channel',
        { channel_id: args.channel_id },
      );
    }
    const entry: PairingEntry = { sock: null, timer: null, settle: null };
    this.pairingSockets.set(args.channel_id, entry);

    let dir: string;
    let sock: WASocket;
    try {
      dir = pairingAuthDir(args.channel_id);
      mkdirSync(dir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      let version: [number, number, number] | undefined;
      try {
        version = (await fetchLatestBaileysVersion()).version;
      } catch {
        /* fallback para a versão da lib */
      }
      sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
      sock.ev.on('creds.update', saveCreds);
    } catch (err) {
      // Setup falhou antes do socket existir — libera a reserva e propaga
      // (o chamador encerra o pairing com `failed`; nada fica pendente).
      this.pairingSockets.delete(args.channel_id);
      throw err;
    }
    // O operador pode ter abortado DURANTE o setup assíncrono acima — a
    // reserva já não é nossa: encerra o socket órfão e falha explicitamente
    // (nunca deixa uma sessão fantasma sem entrada no mapa).
    if (this.pairingSockets.get(args.channel_id) !== entry) {
      try {
        sock.end(undefined);
      } catch {
        /* já fechado */
      }
      throw new TypedError('pairing_aborted', 'pairing aborted during session setup', {
        channel_id: args.channel_id,
      });
    }
    entry.sock = sock;

    return new Promise<PairingResult>((resolvePromise, rejectPromise) => {
      // Settle EXATAMENTE uma vez — cobre open vs TTL vs abort (o segundo
      // `open` de um socket zumbi não pode re-executar a promoção: o rm +
      // rename repetidos destruiriam o auth state recém-promovido).
      let settled = false;
      entry.settle = (r) => {
        if (settled) return;
        settled = true;
        resolvePromise(r);
      };
      entry.timer = setTimeout(() => {
        // abortPairing resolve a promise via entry.settle (matched: false).
        void this.abortPairing(args.channel_id, 'ttl_expired');
      }, PAIRING_TTL_MS);

      sock.ev.on('connection.update', (u) => {
        if (u.qr) args.onUpdate?.({ qr: u.qr, state: 'pairing_qr' });
        if (u.connection === 'open') {
          if (settled) return;
          // Marca SINCRONAMENTE: um segundo `open` (socket zumbi) durante a
          // promoção assíncrona repetiria rm+rename e destruiria o auth
          // state recém-promovido.
          settled = true;
          const rawJid = sock.user?.id ?? '';
          const digits = rawJid.split(':')[0]?.split('@')[0] ?? '';
          const actual = digits ? `+${digits.replace(/^\+/, '')}` : null;
          const matched = actual !== null && actual === args.declared_line;
          logger.info(
            { channel_id: args.channel_id, actual, declared: args.declared_line, matched },
            'pairing_session.connected',
          );
          if (entry.timer) clearTimeout(entry.timer);
          this.pairingSockets.delete(args.channel_id);
          // Encerra o socket de pareamento SEMPRE — a sessão de roteamento
          // (se casou) sobe do dir promovido, nunca deste socket.
          sock.end(undefined);
          void (async () => {
            try {
              if (matched) {
                const target = lineAuthDir(args.channel_id);
                mkdirSync(pathResolve(config.BAILEYS_AUTH_DIR, 'lines'), { recursive: true });
                if (existsSync(target)) await rm(target, { recursive: true, force: true });
                await rename(dir, target);
              } else {
                await rm(dir, { recursive: true, force: true });
              }
              resolvePromise({ matched, actual_line: actual });
            } catch (err) {
              // Review #498 (alto 4): falha de filesystem REJEITA a promise
              // externa — antes ela ficava pendente e o pairing preso em
              // `pairing`. Auth dir de pareamento destruído best-effort
              // (fail-closed: sem promoção não há posse).
              await rm(dir, { recursive: true, force: true }).catch(() => undefined);
              rejectPromise(err as Error);
            }
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
    if (entry.timer) clearTimeout(entry.timer);
    this.pairingSockets.delete(channelId);
    try {
      entry.sock?.end(undefined);
    } catch {
      /* já fechado */
    }
    await rm(pairingAuthDir(channelId), { recursive: true, force: true });
    // Resolve a promise pendente (matched: false) — review #498 alto 4:
    // o abort deixava a promise da PairingSession pendente para sempre.
    entry.settle?.({ matched: false, actual_line: null });
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
