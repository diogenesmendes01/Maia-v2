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
import { join, dirname } from 'node:path';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sha256 } from '@/lib/utils.js';
import { mensagensRepo } from '@/db/repositories.js';
import { isDuplicate, markSeen } from './dedup.js';
import { enqueueAgent } from './queue.js';
import { audit } from '@/governance/audit.js';
import type { WhatsAppInbound } from './types.js';

let socket: WASocket | null = null;
let connected = false;
let lastDisconnectAt: Date | null = null;

const MEDIA_ROOT = join(config.BAILEYS_AUTH_DIR, '..', 'media');
mkdirSync(MEDIA_ROOT, { recursive: true });

export function isBaileysConnected(): boolean {
  return connected;
}

export function getSocket(): WASocket | null {
  return socket;
}

export async function startBaileys(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.BAILEYS_AUTH_DIR);
  socket = makeWASocket({ auth: state, printQRInTerminal: false });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { connection: conn, lastDisconnect, qr } = update;
    if (qr) qrcodeTerminal.generate(qr, { small: true });
    if (conn === 'open') {
      connected = true;
      logger.info('baileys.connected');
      await audit({ acao: 'whatsapp_connected' });
    } else if (conn === 'close') {
      connected = false;
      lastDisconnectAt = new Date();
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      logger.warn({ reason }, 'baileys.connection_closed');
      await audit({ acao: 'whatsapp_disconnected', metadata: { reason } });
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          startBaileys().catch((e) => logger.error({ err: e }, 'baileys.reconnect_failed'));
        }, 5000);
      } else {
        logger.error('baileys.logged_out — manual re-pair required');
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
}

async function handleIncoming(msg: proto.IWebMessageInfo): Promise<void> {
  if (msg.key.fromMe) return;
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

export async function sendOutboundText(jid: string, text: string): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send');
    return null;
  }
  const result = await socket.sendMessage(jid, { text });
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
