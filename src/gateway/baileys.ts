import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sha256 } from '@/lib/utils.js';
import { mensagensRepo } from '@/db/repositories.js';
import { isDuplicate, markSeen } from './dedup.js';
import { markRead } from './presence.js';
import { enqueueAgent } from './queue.js';
import { checkBotAndMaybeBlock } from './bot-detection.js';
import { audit } from '@/governance/audit.js';
import { dispatchReactionAsAnswer, dispatchPollVote } from '@/agent/one-tap.js';
import { routeMessageUpdate } from '@/agent/message-update.js';
import type { WhatsAppInbound, WAQuotedContext } from './types.js';
import { setupState } from '@/setup/state.js';
import { triggerRecovery } from '@/setup/recovery.js';

let socket: WASocket | null = null;
let connected = false;
let lastDisconnectAt: Date | null = null;

export const MEDIA_ROOT = join(config.BAILEYS_AUTH_DIR, '..', 'media');
mkdirSync(MEDIA_ROOT, { recursive: true });
// B3b: tmp subdir for in-flight PDF reports. Created here (idempotent) so any
// caller importing MEDIA_ROOT can rely on `<MEDIA_ROOT>/tmp` existing.
mkdirSync(join(MEDIA_ROOT, 'tmp'), { recursive: true });

export function isBaileysConnected(): boolean {
  return connected;
}

/**
 * SETUP: request an 8-digit pairing code from WhatsApp. Used when the
 * operator chooses "Pair with phone number" in the /setup endpoint.
 * Throws `baileys_socket_not_ready` if the socket hasn't been initialised
 * yet (boot race: startServer() runs before startBaileys()). Caller (the
 * /setup/start route) translates the throw into 503 + retry_after_s.
 */
export async function triggerPairingCode(phone: string): Promise<string> {
  if (!socket) throw new Error('baileys_socket_not_ready');
  return socket.requestPairingCode(phone);
}

export function getSocket(): WASocket | null {
  return socket;
}

type StubLike = { messageStubType?: number | null | undefined };

/**
 * Numeric value of `proto.WebMessageInfo.StubType.REACTION` in Baileys.
 * Hard-coded as a number to keep `proto` as a type-only import (importing
 * it as a value pulls in the full protobuf runtime). If Baileys ever
 * renumbers the enum, the unit test for `isReactionStub` will catch it.
 */
export const REACTION_STUB_TYPE = 67;

export function isReactionStub(msg: StubLike): boolean {
  return msg.messageStubType === REACTION_STUB_TYPE;
}

export async function startBaileys(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.BAILEYS_AUTH_DIR);
  socket = makeWASocket({ auth: state, printQRInTerminal: false });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { connection: conn, lastDisconnect, qr } = update;
    if (qr) {
      const phaseBefore = setupState.current().phase;
      setupState.setQr(qr);
      if (phaseBefore !== 'pairing_qr') {
        await audit({ acao: 'pairing_qr_displayed', metadata: {} });
      }
      qrcodeTerminal.generate(qr, { small: true });    // keep stdout for dev/log spelunking
    }
    if (conn === 'open') {
      connected = true;
      logger.info('baileys.connected');
      await audit({ acao: 'whatsapp_connected' });
      setupState.markPaired();
      await audit({ acao: 'pairing_completed' });
    } else if (conn === 'close') {
      connected = false;
      lastDisconnectAt = new Date();
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      logger.warn({ reason }, 'baileys.connection_closed');
      await audit({ acao: 'whatsapp_disconnected', metadata: { reason } });
      if (reason === DisconnectReason.loggedOut) {
        await audit({ acao: 'pairing_logged_out', metadata: { reason } });
        triggerRecovery({ shutdownBaileys, startBaileys }).catch((err) => {
          logger.error({ err }, 'setup.recovery_failed');
        });
      } else {
        setupState.markDisconnected();
        setTimeout(() => {
          startBaileys().catch((e) => logger.error({ err: e }, 'baileys.reconnect_failed'));
        }, 5000);
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleIncoming(msg);
      } catch (err) {
        logger.error({ err }, 'baileys.handle_failed');
      }
    }
  });

  socket.ev.on('messages.update', async (updates) => {
    if (!config.FEATURE_MESSAGE_UPDATE) return;
    for (const update of updates) {
      try {
        // Baileys 6.7.0 delivers `update` as `{ key, update: Partial<WAMessageInfo> }`.
        // We synthesise an IWebMessageInfo whose `message` is the `update.message`
        // payload so routeMessageUpdate can branch on editedMessage / protocolMessage.
        // The `as never` cast is intentional — runtime structure is what matters.
        await routeMessageUpdate({
          key: update.key,
          message: update.update.message,
        } as never);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'message_update.dispatch_failed');
      }
    }
  });
}

async function handleIncoming(msg: proto.IWebMessageInfo): Promise<void> {
  if (msg.key.fromMe) return;

  // B1: poll vote arrives as a pollUpdateMessage. When FEATURE_ONE_TAP is on,
  // route to the one-tap dispatcher and drop. When off, fall through to the
  // existing pipeline (preserves pre-B1 behaviour).
  if (msg.message?.pollUpdateMessage) {
    if (config.FEATURE_ONE_TAP) {
      await dispatchPollVote(msg).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'one_tap.poll_dispatch_failed'),
      );
      return;
    }
    // flag off → fall through; existing extractContent classifies as 'sistema'
  }

  if (isReactionStub(msg)) {
    // existing behaviour: never persist reactions; absorb as one-tap when on.
    if (config.FEATURE_ONE_TAP) {
      await dispatchReactionAsAnswer(msg).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'one_tap.reaction_dispatch_failed'),
      );
    }
    return;
  }
  const remote_jid = msg.key.remoteJid;
  const whatsapp_id = msg.key.id;
  if (!remote_jid || !whatsapp_id) return;

  const is_group = remote_jid.endsWith('@g.us');
  if (is_group) {
    await audit({ acao: 'group_message_ignored', metadata: { remote_jid } });
    return;
  }

  if (await isDuplicate(whatsapp_id)) {
    await audit({ acao: 'duplicate_message_dropped', metadata: { whatsapp_id } });
    return;
  }

  const phone = remote_jid.split('@')[0]!;
  const tel = '+' + phone;

  if (await checkBotAndMaybeBlock(tel)) {
    logger.warn({ tel: '[REDACTED]' }, 'baileys.dropped_anomalous_volume');
    return;
  }

  const { type, content, mediaPath, mediaMime, mediaSha256 } = await extractContent(msg);

  const { row: stored, duplicate } = await mensagensRepo.createInbound({
    conversa_id: null,
    direcao: 'in',
    tipo: type,
    conteudo: content,
    midia_url: mediaPath,
    metadata: {
      whatsapp_id,
      remote_jid,
      telefone: tel,
      pushname: msg.pushName ?? null,
      timestamp_ms: Number(msg.messageTimestamp ?? 0) * 1000,
      media_mime: mediaMime,
      media_sha256: mediaSha256,
    },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
  });

  await markSeen(whatsapp_id);
  markRead(remote_jid, whatsapp_id);
  if (duplicate) {
    await audit({ acao: 'duplicate_message_dropped', metadata: { whatsapp_id, source: 'db_unique' } });
    return;
  }
  await enqueueAgent({ mensagem_id: stored.id });
  logger.info({ mensagem_id: stored.id, tel: '[REDACTED]' }, 'baileys.message.enqueued');
}

async function extractContent(msg: proto.IWebMessageInfo): Promise<{
  type: WhatsAppInbound['type'];
  content: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaSha256: string | null;
}> {
  const m = msg.message;
  if (!m) return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null };

  if (m.conversation) {
    return { type: 'texto', content: m.conversation, mediaPath: null, mediaMime: null, mediaSha256: null };
  }
  if (m.extendedTextMessage?.text) {
    return {
      type: 'texto',
      content: m.extendedTextMessage.text,
      mediaPath: null,
      mediaMime: null,
      mediaSha256: null,
    };
  }
  // Media branches: we save the buffer (when available)
  type MediaKind = 'audioMessage' | 'imageMessage' | 'documentMessage';
  const mediaKind: MediaKind | null = m.audioMessage
    ? 'audioMessage'
    : m.imageMessage
      ? 'imageMessage'
      : m.documentMessage
        ? 'documentMessage'
        : null;
  if (!mediaKind) {
    return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null };
  }

  const mime = (m as Record<string, { mimetype?: string; caption?: string }>)[mediaKind]?.mimetype ?? null;
  const caption = (m as Record<string, { mimetype?: string; caption?: string }>)[mediaKind]?.caption ?? null;
  const type: WhatsAppInbound['type'] =
    mediaKind === 'audioMessage' ? 'audio' : mediaKind === 'imageMessage' ? 'imagem' : 'documento';
  let mediaPath: string | null = null;
  let mediaSha256: string | null = null;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {});
    if (Buffer.isBuffer(buf)) {
      const ext =
        mime?.split('/')[1]?.split(';')[0] ?? (type === 'audio' ? 'ogg' : type === 'imagem' ? 'jpg' : 'bin');
      const saved = mediaPathFor(buf, ext);
      mediaPath = saved.path;
      mediaSha256 = saved.sha;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'baileys.media_download_failed');
  }
  return { type, content: caption, mediaPath, mediaMime: mime, mediaSha256 };
}

export async function sendOutboundText(
  jid: string,
  text: string,
  opts?: { quoted?: WAQuotedContext; view_once?: boolean },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send');
    return null;
  }
  const useViewOnce = !!opts?.view_once && config.FEATURE_VIEW_ONCE_SENSITIVE;
  const content = useViewOnce ? { text, viewOnce: true } : { text };
  // Baileys' sendMessage accepts `quoted` as third-arg MiscMessageGenerationOptions.
  // We always pass the third arg (undefined when no quote) so call arity is stable.
  const miscOpts = opts?.quoted ? { quoted: opts.quoted } : undefined;
  const result = await socket.sendMessage(jid, content, miscOpts);
  return result?.key.id ?? null;
}

/**
 * B3b: send a document (PDF) to the recipient. Reads the file into a Buffer
 * (PDFs are bounded by the 500-row hard limit at <500KB, well within memory),
 * eliminating the partially-sent-on-error edge case. View-once is intentionally
 * NOT supported here — see B3b spec §11 for rationale.
 */
export async function sendOutboundDocument(
  jid: string,
  path: string,
  opts: {
    mimetype: string;
    fileName: string;
    caption?: string;
    quoted?: WAQuotedContext;
  },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send document');
    return null;
  }
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    logger.error({ err, path }, 'baileys.send_document.read_failed');
    return null;
  }
  const result = await socket.sendMessage(
    jid,
    {
      document: buf,
      mimetype: opts.mimetype,
      fileName: opts.fileName,
      caption: opts.caption,
    },
    opts.quoted ? { quoted: opts.quoted } : undefined,
  );
  return result?.key.id ?? null;
}

export async function shutdownBaileys(): Promise<void> {
  if (socket) {
    socket.end(undefined);
    socket = null;
  }
}

export function getLastDisconnectAt(): Date | null {
  return lastDisconnectAt;
}

// Test-only seam. Production code never calls this. Lets unit tests inject a
// mock socket without booting the full WA pairing flow.
export const _internal = {
  _setSocketForTests(s: WASocket | null, isConnected: boolean): void {
    socket = s;
    connected = isConnected;
  },
};

// Helper to deterministically create per-message media filenames
export function mediaPathFor(buf: Buffer, ext: string): { path: string; sha: string } {
  const sha = sha256(buf);
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(MEDIA_ROOT, month);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.${ext}`);
  if (!existsSync(path)) writeFileSync(path, buf);
  return { path, sha };
}
