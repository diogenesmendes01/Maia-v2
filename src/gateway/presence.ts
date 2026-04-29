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

const REFRESH_MS = 8_000;

type Entry = {
  handle: TypingHandle;
  jid: string;
  timer: NodeJS.Timeout;
  started_at: number;
};

const handles = new Map<string, Entry>();

export function startTyping(remote_jid: string, mensagem_id: string): TypingHandle {
  if (!config.FEATURE_PRESENCE) return NOOP_HANDLE;
  if (!isBaileysConnected()) return NOOP_HANDLE;
  const existing = handles.get(mensagem_id);
  if (existing) return existing.handle;

  const sock = getSocket();
  if (!sock) return NOOP_HANDLE;

  const send = () =>
    sock
      .sendPresenceUpdate('composing', remote_jid)
      .catch((err: Error) => logger.warn({ err: err.message }, 'presence.typing_failed'));
  void send();
  const timer = setInterval(send, REFRESH_MS);

  let stopped = false;
  const handle: TypingHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      handles.delete(mensagem_id);
      sock
        .sendPresenceUpdate('paused', remote_jid)
        .catch((err: Error) => logger.warn({ err: err.message }, 'presence.typing_paused_failed'));
    },
  };
  handles.set(mensagem_id, { handle, jid: remote_jid, timer, started_at: Date.now() });
  return handle;
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

const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

function runStaleSweep(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, entry] of handles) {
    if (entry.started_at < cutoff) {
      entry.handle.stop();
      logger.warn({ mensagem_id: id, age_ms: Date.now() - entry.started_at }, 'presence.typing_stale_swept');
    }
  }
}

const sweepTimer = setInterval(runStaleSweep, SWEEP_MS);
sweepTimer.unref?.();

function drainAll(): void {
  for (const entry of handles.values()) entry.handle.stop();
}

process.once('beforeExit', drainAll);

export const _internal = { runStaleSweep, drainAll, handles };
