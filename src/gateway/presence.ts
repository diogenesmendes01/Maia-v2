import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import type { WAQuotedContext } from './types.js';

export type { WAQuotedContext } from './types.js';

export interface TypingHandle {
  stop(): void;
}

const NOOP_HANDLE: TypingHandle = { stop: () => undefined };

export function markRead(_remote_jid: string, _whatsapp_id: string): void {
  if (!config.FEATURE_PRESENCE) return;
  // implemented in Task 4
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

void logger; // suppress unused until used
