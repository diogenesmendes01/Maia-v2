import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { isBaileysConnected, getSocket } from './baileys.js';
import type { WAQuotedContext } from './types.js';

export type { WAQuotedContext } from './types.js';

export interface TypingHandle {
  stop(): void;
}

const NOOP_HANDLE: TypingHandle = { stop: () => undefined };

/**
 * WhatsApp JID format: digits@s.whatsapp.net (individual) or digits@g.us
 * (group). Validate before passing to Baileys so a malformed metadata
 * field doesn't bubble down into the socket call as `undefined@...`.
 */
const JID_REGEX = /^\d{5,20}@(s\.whatsapp\.net|g\.us)$/;

function validJid(jid: string): boolean {
  return JID_REGEX.test(jid);
}

export function markRead(remote_jid: string, whatsapp_id: string): void {
  if (!config.FEATURE_PRESENCE) return;
  if (!isBaileysConnected()) return;
  if (!validJid(remote_jid) || !whatsapp_id) {
    logger.warn({ remote_jid: '[REDACTED]' }, 'presence.invalid_jid_mark_read');
    return;
  }
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
  if (!validJid(remote_jid)) {
    logger.warn({ remote_jid: '[REDACTED]' }, 'presence.invalid_jid_typing');
    return NOOP_HANDLE;
  }
  const existing = handles.get(mensagem_id);
  if (existing) return existing.handle;

  const sock = getSocket();
  if (!sock) return NOOP_HANDLE;

  const send = (): Promise<void> =>
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
  remote_jid: string,
  whatsapp_id: string,
  emoji: '✅' | '❌',
): void {
  if (!config.FEATURE_PRESENCE) return;
  if (!isBaileysConnected()) return;
  if (!validJid(remote_jid) || !whatsapp_id) {
    logger.warn({ remote_jid: '[REDACTED]' }, 'presence.invalid_jid_reaction');
    return;
  }
  const sock = getSocket();
  if (!sock) return;
  sock
    .sendMessage(remote_jid, {
      react: { text: emoji, key: { remoteJid: remote_jid, id: whatsapp_id, fromMe: false } },
    })
    .catch((err: Error) => logger.warn({ err: err.message }, 'presence.reaction_failed'));
}

export type SendPollResult = {
  whatsapp_id: string | null;
  message_secret: string | null; // base64 — needed to decrypt votes
};

/**
 * B1: send a native WhatsApp poll. The returned `message_secret` is the
 * per-poll secret that decryptPollVote() needs to decode incoming votes.
 * Persist it on the outbound mensagens row so the receive-side handler
 * can look it up by `metadata.whatsapp_id`.
 *
 * No-op when FEATURE_ONE_TAP is off OR Baileys is disconnected — caller
 * falls back to a plain-text question + numbered list.
 */
export async function sendPoll(
  remote_jid: string,
  question: string,
  options: ReadonlyArray<{ key: string; label: string }>,
): Promise<SendPollResult> {
  if (!config.FEATURE_ONE_TAP) return { whatsapp_id: null, message_secret: null };
  if (!isBaileysConnected()) return { whatsapp_id: null, message_secret: null };
  if (!validJid(remote_jid)) {
    logger.warn({ remote_jid: '[REDACTED]' }, 'presence.invalid_jid_send_poll');
    return { whatsapp_id: null, message_secret: null };
  }
  const sock = getSocket();
  if (!sock) return { whatsapp_id: null, message_secret: null };
  try {
    const result = await sock.sendMessage(remote_jid, {
      poll: {
        name: question,
        values: options.map((o) => o.label),
        selectableCount: 1,
      },
    });
    const secretBuf = (result?.message?.messageContextInfo as { messageSecret?: Uint8Array } | undefined)
      ?.messageSecret;
    return {
      whatsapp_id: result?.key?.id ?? null,
      message_secret: secretBuf ? Buffer.from(secretBuf).toString('base64') : null,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence.send_poll_failed');
    return { whatsapp_id: null, message_secret: null };
  }
}

const QUOTED_TRUNCATE = 200;

export function quotedReplyContext(
  inbound_metadata: Record<string, unknown> | null,
  inbound_conteudo: string | null,
): WAQuotedContext | undefined {
  if (!inbound_metadata) return undefined;
  const whatsapp_id = inbound_metadata.whatsapp_id;
  const remote_jid = inbound_metadata.remote_jid;
  if (typeof whatsapp_id !== 'string' || typeof remote_jid !== 'string') return undefined;
  if (!validJid(remote_jid)) return undefined;
  return {
    key: { remoteJid: remote_jid, id: whatsapp_id, fromMe: false },
    message: { conversation: (inbound_conteudo ?? '').slice(0, QUOTED_TRUNCATE) },
  };
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

// `beforeExit` only fires when the event loop empties — it does NOT cover
// SIGTERM (k8s/docker shutdown) or SIGINT (Ctrl+C). Listen for those too so
// the typing intervals get cleaned up on every shutdown path. We re-emit the
// signal after draining so Node's default termination behavior takes over
// (the `.once` listener has auto-removed by then).
//
// Guarded by a Symbol on globalThis so test runners that re-import the
// module (vi.resetModules) don't pile up duplicate listeners.
const SHUTDOWN_INSTALLED = Symbol.for('maia.presence.shutdown_handlers');
type GlobalWithFlag = typeof globalThis & { [SHUTDOWN_INSTALLED]?: boolean };
const g = globalThis as GlobalWithFlag;
if (!g[SHUTDOWN_INSTALLED]) {
  g[SHUTDOWN_INSTALLED] = true;
  process.once('beforeExit', drainAll);
  const onSignal = (signal: NodeJS.Signals): void => {
    drainAll();
    process.kill(process.pid, signal);
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

export const _internal = { runStaleSweep, drainAll, handles, validJid };
