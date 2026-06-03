import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Issue #290 / PR #311 — B3: reaction stubs were unreachable.
 *
 * Codex review: the `messages.upsert` listener ran `if (!msg.message) continue`
 * BEFORE delegating to `handleIncoming`. WhatsApp reaction events arrive as a
 * STUB — `msg.message === undefined` with `messageStubType === REACTION_STUB_TYPE`
 * (67). So the `isReactionStub(msg)` branch inside `handleIncoming` (which
 * routes to the one-tap reaction dispatcher) was DEAD CODE: every reaction stub
 * was dropped at the `!msg.message` guard.
 *
 * Fix: the listener now lets reaction stubs THROUGH the guard
 * (`if (!msg.message && !isReactionStub(msg)) continue`) and resolves the tenant
 * context first (reaction stubs carry `msg.key.remoteJid`, all the JID→tenant
 * resolver needs), so `dispatchReactionAsAnswer` runs INSIDE the resolved tenant
 * context — it calls tenant-scoped repos and would throw without an ALS.
 *
 * These specs drive the real `messages.upsert` listener with a reaction-stub
 * envelope and assert the one-tap dispatcher is invoked (with a context active),
 * and that a pure receipt (no content, no stub) is still skipped.
 */

const {
  dispatchReactionAsAnswerMock,
  dispatchPollVoteMock,
  createInboundMock,
  auditMock,
  fakeSocket,
  handlerState,
  contextProbe,
} = vi.hoisted(() => {
  const state: {
    upsertHandler: ((args: { messages: unknown[] }) => Promise<void>) | null;
  } = { upsertHandler: null };
  const contextProbe: { tenant_id: string | null; agent_id: string | null } = {
    tenant_id: null,
    agent_id: null,
  };
  return {
    dispatchReactionAsAnswerMock: vi.fn().mockResolvedValue(undefined),
    dispatchPollVoteMock: vi.fn().mockResolvedValue(undefined),
    createInboundMock: vi.fn().mockResolvedValue({ row: { id: 'x' }, duplicate: false }),
    auditMock: vi.fn().mockResolvedValue(undefined),
    handlerState: state,
    contextProbe,
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

// FEATURE_ONE_TAP must be ON so the reaction-stub branch routes to the
// dispatcher (rather than absorbing the reaction silently). The reachability
// fix is orthogonal to channel resolution; after #411 the resolver ALWAYS runs
// and the single-tenant catch-all maps the stub's sender JID to the seeded
// default/default channel — enough to prove the stub reaches the dispatcher
// inside a tenant context.
vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-reaction-stub-test',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: true,
    FEATURE_MESSAGE_DEBOUNCE: false,
    FEATURE_PRESENCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));

vi.mock('../../src/config/feature-flags.js', () => ({
  // COGNITIVE_GRAPH off (the only flag still read); MULTI_CHANNEL removed (#411).
  featureFlags: { isEnabled: vi.fn(() => false) },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: {
    createInbound: createInboundMock,
    findByWhatsappIdCrossTenant: vi.fn().mockResolvedValue(null),
  },
  // #411: the resolver now always runs. Single-tenant catch-all → the seeded
  // default/default channel for any sender (exact-match always misses).
  channelsRepo: {
    findByExternalCrossTenant: vi.fn().mockResolvedValue(null),
    findDefaultCatchAllChannel: vi.fn().mockResolvedValue({
      multi_tenant: false,
      channel: {
        id: 'default-channel-uuid',
        tenant_id: 'default',
        agent_id: 'default',
        external_id: 'default-channel',
        channel_type: 'whatsapp',
        active: true,
      },
    }),
  },
}));

vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  markSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn() }));
vi.mock('../../src/gateway/debouncer.js', () => ({ scheduleDebouncedAgent: vi.fn() }));
vi.mock('../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

// The one-tap dispatcher captures the ambient tenant context when called, so
// the test can prove the stub is dispatched INSIDE runWithTenantContext.
vi.mock('../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: dispatchReactionAsAnswerMock,
  dispatchPollVote: dispatchPollVoteMock,
}));

vi.mock('../../src/agent/message-update.js', () => ({
  routeMessageUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/setup/state.js', () => ({
  setupState: {
    current: () => ({ phase: 'connected' }),
    setQr: vi.fn(),
    markPaired: vi.fn(),
    markDisconnected: vi.fn(),
  },
}));
vi.mock('../../src/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), existsSync: () => true, writeFileSync: vi.fn() };
});

import { startBaileys, REACTION_STUB_TYPE } from '../../src/gateway/baileys.js';
import { tryGetCurrentContext } from '../../src/db/tenant-context.js';

describe('baileys messages.upsert — reaction stubs are reachable (PR #311 B3)', () => {
  beforeEach(() => {
    dispatchReactionAsAnswerMock.mockClear();
    dispatchPollVoteMock.mockClear();
    createInboundMock.mockClear();
    handlerState.upsertHandler = null;
    contextProbe.tenant_id = null;
    contextProbe.agent_id = null;
  });

  it('reaction stub (msg.message undefined, messageStubType=67) reaches dispatchReactionAsAnswer INSIDE a tenant context', async () => {
    dispatchReactionAsAnswerMock.mockImplementationOnce(async () => {
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('dispatchReactionAsAnswer ran with NO tenant context');
      contextProbe.tenant_id = ctx.tenant_id;
      contextProbe.agent_id = ctx.agent_id;
    });

    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    // A reaction STUB: no `message` payload, only the stub type + key.
    const reactionStub = {
      key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-REACT-1' },
      messageStubType: REACTION_STUB_TYPE,
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    await handlerState.upsertHandler!({ messages: [reactionStub] });

    // Pre-fix: this dispatcher was dead code (the !msg.message guard dropped
    // the stub). Post-fix it MUST be invoked.
    expect(dispatchReactionAsAnswerMock).toHaveBeenCalledTimes(1);
    // And it ran inside a tenant context (legacy default/default here).
    expect(contextProbe.tenant_id).toBe('default');
    expect(contextProbe.agent_id).toBe('default');
    // A reaction stub is never persisted as an inbound message.
    expect(createInboundMock).not.toHaveBeenCalled();
  });

  it('pure receipt (no message, not a reaction stub) is still skipped — no dispatch, no resolver round-trip', async () => {
    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    const receipt = {
      key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-RECEIPT' },
      // no `message`, no `messageStubType`
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    await handlerState.upsertHandler!({ messages: [receipt] });

    expect(dispatchReactionAsAnswerMock).not.toHaveBeenCalled();
    expect(createInboundMock).not.toHaveBeenCalled();
  });

  it('regular text message still flows to createInbound (reaction-stub change did not break the content path)', async () => {
    await startBaileys();
    const textMsg = {
      key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-TEXT' },
      message: { conversation: 'oi maia' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Cliente',
    };
    await handlerState.upsertHandler!({ messages: [textMsg] });

    expect(createInboundMock).toHaveBeenCalledTimes(1);
    expect(dispatchReactionAsAnswerMock).not.toHaveBeenCalled();
  });
});
