import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for PR #75 review finding #1 (Codex) / #C1 (Superpowers):
 *
 * `mensagensRepo.createInbound` and `pessoasRepo.*` now call
 * `getCurrentTenant()` / `applyTenantGuard`. Without a `runWithTenantContext`
 * wrap at the gateway entry point, every real WhatsApp inbound throws
 * `MissingTenantContextError` and is silently swallowed by the
 * `baileys.handle_failed` catch in `startBaileys`'s upsert handler.
 *
 * Fix: the `messages.upsert` and `messages.update` listeners wrap each
 * dispatch in `runWithTenantContext({ tenant_id:'default', agent_id:'default' })`.
 * This test captures the listener registered with the fake socket, fires a
 * synthetic inbound through it, and asserts that:
 *
 *   1. `mensagensRepo.createInbound` ran INSIDE a tenant context
 *      (no MissingTenantContextError thrown);
 *   2. the tenant active at the call site is 'default' (P0 default; P6 will
 *      replace this with channel→tenant resolution).
 */

const {
  createInboundMock,
  enqueueAgentMock,
  auditMock,
  isDuplicateMock,
  markSeenMock,
  checkBotAndMaybeBlockMock,
  fakeSocket,
  handlerState,
} = vi.hoisted(() => {
  const state: {
    upsertHandler:
      | ((args: { messages: unknown[] }) => Promise<void>)
      | null;
  } = { upsertHandler: null };
  return {
    createInboundMock: vi.fn(),
    enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    isDuplicateMock: vi.fn().mockResolvedValue(false),
    markSeenMock: vi.fn().mockResolvedValue(undefined),
    checkBotAndMaybeBlockMock: vi.fn().mockResolvedValue(false),
    handlerState: state,
    fakeSocket: {
      ev: {
        on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
          if (event === 'messages.upsert') {
            state.upsertHandler = handler as typeof state.upsertHandler;
          }
        },
      },
      end: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-tenant-ctx-test',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_DEBOUNCE: false,
    FEATURE_PRESENCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: createInboundMock },
}));

vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: isDuplicateMock,
  markSeen: markSeenMock,
}));

vi.mock('../../src/gateway/presence.js', () => ({
  markRead: vi.fn(),
}));

vi.mock('../../src/gateway/queue.js', () => ({
  enqueueAgent: enqueueAgentMock,
}));

vi.mock('../../src/gateway/debouncer.js', () => ({
  scheduleDebouncedAgent: vi.fn(),
}));

vi.mock('../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: checkBotAndMaybeBlockMock,
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));

vi.mock('../../src/agent/message-update.js', () => ({
  routeMessageUpdate: vi.fn(),
}));

vi.mock('../../src/setup/state.js', () => ({
  setupState: {
    current: () => ({ phase: 'connected' }),
    setQr: vi.fn(),
    markPaired: vi.fn(),
    markDisconnected: vi.fn(),
  },
}));

vi.mock('../../src/setup/recovery.js', () => ({
  triggerRecovery: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), existsSync: () => true, writeFileSync: vi.fn() };
});

import { startBaileys } from '../../src/gateway/baileys.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  tryGetCurrentContext,
} from '../../src/db/tenant-context.js';

describe('baileys handleIncoming — runs inside tenant context (PR #75 #C1)', () => {
  beforeEach(() => {
    createInboundMock.mockReset();
    enqueueAgentMock.mockClear();
    handlerState.upsertHandler = null;
  });

  it('createInbound is called inside runWithTenantContext (tenant=default, agent=default)', async () => {
    let capturedTenant: string | null = null;
    let capturedAgent: string | null = null;
    createInboundMock.mockImplementation(async () => {
      // tryGetCurrentContext returns null if we're outside any runWithTenantContext.
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('no tenant context active when createInbound ran');
      capturedTenant = getCurrentTenant();
      capturedAgent = getCurrentAgent();
      return {
        row: {
          id: 'msg-uuid-1',
          tenant_id: ctx.tenant_id,
          agent_id: ctx.agent_id,
        },
        duplicate: false,
      };
    });

    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    // Synthesise a minimal inbound text message.
    const fakeMsg = {
      key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-IN-1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'oi maia' },
      pushName: 'Cliente',
    };

    await handlerState.upsertHandler!({ messages: [fakeMsg] });

    expect(createInboundMock).toHaveBeenCalledTimes(1);
    expect(capturedTenant).toBe('default');
    expect(capturedAgent).toBe('default');
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-uuid-1' });
  });
});
