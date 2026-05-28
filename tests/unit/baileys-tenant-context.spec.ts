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
 * dispatch in `runWithTenantContext`. For `messages.upsert` the wrap uses
 * `default/default` (adoption to the real tenant happens later inside
 * `runAgentForMensagem`, after the channel resolver). For `messages.update`
 * (PR #277 v2 BLOQUEADO fix) the wrap uses the (tenant_id, agent_id) of
 * the ORIGINAL message — looked up via the sanctioned cross-tenant helper
 * `mensagensRepo.findByWhatsappIdCrossTenant` — because the original may
 * have been adopted away from default/default by the agent worker, and
 * running the dispatch under default/default would silently drop the
 * edit/revoke (edit_unknown_original / revoke_unknown_original).
 */

const {
  createInboundMock,
  enqueueAgentMock,
  auditMock,
  isDuplicateMock,
  markSeenMock,
  checkBotAndMaybeBlockMock,
  routeMessageUpdateMock,
  findByWhatsappIdCrossTenantMock,
  fakeSocket,
  handlerState,
} = vi.hoisted(() => {
  const state: {
    upsertHandler:
      | ((args: { messages: unknown[] }) => Promise<void>)
      | null;
    updateHandler:
      | ((updates: unknown[]) => Promise<void>)
      | null;
  } = { upsertHandler: null, updateHandler: null };
  return {
    createInboundMock: vi.fn(),
    enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    isDuplicateMock: vi.fn().mockResolvedValue(false),
    markSeenMock: vi.fn().mockResolvedValue(undefined),
    checkBotAndMaybeBlockMock: vi.fn().mockResolvedValue(false),
    routeMessageUpdateMock: vi.fn().mockResolvedValue(undefined),
    findByWhatsappIdCrossTenantMock: vi.fn().mockResolvedValue(null),
    handlerState: state,
    fakeSocket: {
      ev: {
        on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
          if (event === 'messages.upsert') {
            state.upsertHandler = handler as typeof state.upsertHandler;
          } else if (event === 'messages.update') {
            state.updateHandler = handler as typeof state.updateHandler;
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
    FEATURE_MESSAGE_UPDATE: true,
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
  mensagensRepo: {
    createInbound: createInboundMock,
    findByWhatsappIdCrossTenant: findByWhatsappIdCrossTenantMock,
  },
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
  routeMessageUpdate: routeMessageUpdateMock,
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
    handlerState.updateHandler = null;
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
    // messages.upsert wraps in default/default — adoption to the real
    // (tenant_id, agent_id) is the agent worker's responsibility (after the
    // channel resolver runs in `runAgentForMensagem`). Asserting default
    // here pins the contract: the gateway itself is single-context.
    expect(capturedTenant).toBe('default');
    expect(capturedAgent).toBe('default');
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-uuid-1' });
  });
});

describe('baileys messages.update — runs inside RESOLVED tenant context (PR #277 v2 BLOQUEADO fix)', () => {
  beforeEach(() => {
    routeMessageUpdateMock.mockReset();
    routeMessageUpdateMock.mockResolvedValue(undefined);
    findByWhatsappIdCrossTenantMock.mockReset();
    findByWhatsappIdCrossTenantMock.mockResolvedValue(null);
    handlerState.upsertHandler = null;
    handlerState.updateHandler = null;
  });

  it('edit: routeMessageUpdate runs inside tenant context of the ADOPTED original (NOT default/default)', async () => {
    // Repro: an inbound is adopted by runAgentForMensagem from
    // (default, default) → (tenant-acme, agent-main). A subsequent edit
    // arrives via messages.update. Pre-fix: routeMessageUpdate ran under
    // default/default, mensagensRepo.findByWhatsappId returned null, the
    // edit was silently dropped. Post-fix: the listener resolves the
    // owning tenant via findByWhatsappIdCrossTenant and runs the dispatch
    // inside ALS of that tenant.
    findByWhatsappIdCrossTenantMock.mockResolvedValueOnce({
      id: 'orig-msg-uuid',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      metadata: { whatsapp_id: 'WAID-EDIT-1' },
    });

    let capturedTenant: string | null = null;
    let capturedAgent: string | null = null;
    routeMessageUpdateMock.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('no tenant context active when routeMessageUpdate ran');
      capturedTenant = getCurrentTenant();
      capturedAgent = getCurrentAgent();
    });

    await startBaileys();
    expect(handlerState.updateHandler).not.toBeNull();

    const fakeUpdate = {
      key: { remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-EDIT-1' },
      update: {
        message: {
          editedMessage: { message: { conversation: 'edited text' } },
        },
      },
    };

    await handlerState.updateHandler!([fakeUpdate]);

    expect(findByWhatsappIdCrossTenantMock).toHaveBeenCalledWith('WAID-EDIT-1');
    expect(routeMessageUpdateMock).toHaveBeenCalledTimes(1);
    expect(capturedTenant).toBe('tenant-acme');
    expect(capturedAgent).toBe('agent-main');
  });

  it('revoke: routeMessageUpdate runs inside tenant of the ADOPTED original; target id comes from protocolMessage.key.id', async () => {
    findByWhatsappIdCrossTenantMock.mockResolvedValueOnce({
      id: 'orig-msg-uuid-2',
      tenant_id: 'tenant-zeta',
      agent_id: 'agent-zeta-main',
      metadata: { whatsapp_id: 'WAID-REVOKE-TARGET' },
    });

    let capturedTenant: string | null = null;
    let capturedAgent: string | null = null;
    routeMessageUpdateMock.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('no tenant context active when routeMessageUpdate ran');
      capturedTenant = getCurrentTenant();
      capturedAgent = getCurrentAgent();
    });

    await startBaileys();
    expect(handlerState.updateHandler).not.toBeNull();

    // Revoke envelope: outer key.id is the revoke message itself; the
    // ACTUAL target is protocolMessage.key.id.
    const fakeUpdate = {
      key: { remoteJid: 'jid', id: 'WAID-REVOKE-ENVELOPE' },
      update: {
        message: {
          protocolMessage: {
            type: 0,
            key: { id: 'WAID-REVOKE-TARGET', remoteJid: 'jid' },
          },
        },
      },
    };

    await handlerState.updateHandler!([fakeUpdate]);

    // Critical: lookup uses the revoked target's id, not the envelope's.
    expect(findByWhatsappIdCrossTenantMock).toHaveBeenCalledWith('WAID-REVOKE-TARGET');
    expect(capturedTenant).toBe('tenant-zeta');
    expect(capturedAgent).toBe('agent-zeta-main');
  });

  it('unknown whatsapp_id: skips routeMessageUpdate (no spurious default/default dispatch)', async () => {
    // Genuine miss: no inbound row exists with this id (never seen, or GC'd).
    // The pre-fix behavior was to dispatch under default/default and emit
    // edit_unknown_original; the new behavior short-circuits at the listener
    // — fail-soft, but observable via the cross_tenant_lookup_miss debug log.
    findByWhatsappIdCrossTenantMock.mockResolvedValueOnce(null);

    await startBaileys();
    expect(handlerState.updateHandler).not.toBeNull();

    const fakeUpdate = {
      key: { remoteJid: 'jid', id: 'WAID-UNKNOWN' },
      update: {
        message: { editedMessage: { message: { conversation: 'whatever' } } },
      },
    };

    await handlerState.updateHandler!([fakeUpdate]);

    expect(findByWhatsappIdCrossTenantMock).toHaveBeenCalledWith('WAID-UNKNOWN');
    expect(routeMessageUpdateMock).not.toHaveBeenCalled();
  });

  it('non-edit/non-revoke update (read receipt): no cross-tenant lookup, no dispatch', async () => {
    // A messages.update WITHOUT editedMessage and without protocolMessage
    // type=0 (e.g. a read receipt status flip) should not trigger a DB
    // lookup at all — saves the round-trip on the high-volume non-actionable
    // path.
    await startBaileys();
    expect(handlerState.updateHandler).not.toBeNull();

    const fakeUpdate = {
      key: { remoteJid: 'jid', id: 'WAID-READ-RECEIPT' },
      update: {
        message: { reactionMessage: { text: '👍' } },
      },
    };

    await handlerState.updateHandler!([fakeUpdate]);

    expect(findByWhatsappIdCrossTenantMock).not.toHaveBeenCalled();
    expect(routeMessageUpdateMock).not.toHaveBeenCalled();
  });

  it('does NOT enter runWithTenantContext({default, default}) when original is in a real tenant (regression guard)', async () => {
    // Cristaliza o bug do Codex v2: pré-fix, qualquer messages.update entrava
    // em default/default. Garante que isso jamais acontece para mensagens
    // adotadas em tenant real.
    findByWhatsappIdCrossTenantMock.mockResolvedValueOnce({
      id: 'orig-msg',
      tenant_id: 'tenant-real',
      agent_id: 'agent-real',
      metadata: { whatsapp_id: 'WAID-EDIT-X' },
    });
    const observed: Array<{ tenant_id: string; agent_id: string }> = [];
    routeMessageUpdateMock.mockImplementation(async () => {
      const ctx = tryGetCurrentContext();
      if (ctx) observed.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
    });

    await startBaileys();
    const fakeUpdate = {
      key: { remoteJid: 'jid', id: 'WAID-EDIT-X' },
      update: { message: { editedMessage: { message: { conversation: 'novo' } } } },
    };
    await handlerState.updateHandler!([fakeUpdate]);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ tenant_id: 'tenant-real', agent_id: 'agent-real' });
    expect(observed[0]).not.toEqual({ tenant_id: 'default', agent_id: 'default' });
  });
});
