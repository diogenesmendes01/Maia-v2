import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { isBaileysConnected, getSocket } from './baileys.js';
import type { WAQuotedContext } from './types.js';

export type { WAQuotedContext } from './types.js';

export interface TypingHandle {
  stop(): void;
}

const NOOP_HANDLE: TypingHandle = { stop: () => undefined };

export function markRead(remote_jid: string, whatsapp_id: string): void {
  if (!config.FEATURE_PRESENCE) return;
  if (!isBaileysConnected()) return;
  const sock = getSocket();
  if (!sock) return;
  sock
    .readMessages([{ remoteJid: remote_jid, id: whatsapp_id, fromMe: false }])
    .catch((err: Error) => logger.warn({ err: err.message }, 'presence.mark_read_failed'));
}

export function startTyping(_remote_jid: string, _mensagem_id: string): TypingHandle {
  if (!config.FEATURE_PRESENCE) return NOOP_HANDLE;
  return NOOP_HANDLE; // implemented in Task 5
}

export function sendReaction(
  _remote_jid: string,
  _whatsapp_id: string,
  _emoji: '✅' | '❌',
): void {
  if (!config.FEATURE_PRESENCE) return;
  // implemented in Task 7
}

export function quotedReplyContext(
  _inbound_metadata: Record<string, unknown> | null,
  _inbound_conteudo: string | null,
): WAQuotedContext | undefined {
  return undefined; // implemented in Task 8
}
