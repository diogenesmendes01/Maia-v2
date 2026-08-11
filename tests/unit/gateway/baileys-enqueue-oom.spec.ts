import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Issue #309 follow-up (PR #324 B1) — non-debounced ingress fail-closed on a
 * Redis OOM in `enqueueAgent`.
 *
 * The non-debounced path (`FEATURE_MESSAGE_DEBOUNCE` off, or media) calls
 * `enqueueAgent` directly. The inbound row is already persisted upstream
 * (`createInbound` → `processada_em: null`), so an OOM must NOT crash the
 * ingress and must NOT mark the row processed — `runMessageRecovery` re-enqueues
 * it later. We prove:
 *   - OOM (`QueueRedisUnavailableError`) is caught INSIDE handleIncoming and
 *     logged as `baileys.enqueue_failed_fail_closed`; it never reaches the
 *     outer `baileys.handle_failed` catch.
 *   - A NON-OOM error is NOT absorbed by the fail-closed branch — it propagates
 *     to the outer handler (`baileys.handle_failed`), staying visible. (The
 *     row is still left pending: the "processed" write is never reached.)
 */

const {
  createInboundMock,
  enqueueAgentMock,
  auditMock,
  isDuplicateMock,
  markSeenMock,
  checkBotAndMaybeBlockMock,
  logWarn,
  logError,
  fakeSocket,
  handlerState,
} = vi.hoisted(() => {
  const state: {
    upsertHandler: ((args: { messages: unknown[] }) => Promise<void>) | null;
  } = { upsertHandler: null };
  return {
    createInboundMock: vi.fn(),
    enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    isDuplicateMock: vi.fn().mockResolvedValue(false),
    markSeenMock: vi.fn().mockResolvedValue(undefined),
    checkBotAndMaybeBlockMock: vi.fn().mockResolvedValue(false),
    logWarn: vi.fn(),
    logError: vi.fn(),
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

// The real typed error the queue module throws on OOM.
class QueueRedisUnavailableError extends Error {
  readonly code = 'QUEUE_REDIS_UNAVAILABLE';
  readonly oom: boolean;
  constructor(opts?: { oom?: boolean }) {
    super('test queue unavailable');
    this.name = 'QueueRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-baileys-enqueue-oom-test',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_DEBOUNCE: false, // force the non-debounced enqueueAgent path
    FEATURE_PRESENCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() },
}));

vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    createInbound: createInboundMock,
    findByWhatsappIdCrossTenant: vi.fn().mockResolvedValue(null),
  },
  // #411: the resolver always runs at ingress. Single-tenant catch-all → the
  // seeded primary/primary channel for any sender (exact-match always misses).
  channelsRepo: {
    findByExternalCrossTenant: vi.fn().mockResolvedValue(null),
    findPrimaryCatchAllChannel: vi.fn().mockResolvedValue({
      multi_tenant: false,
      channel: {
        id: 'primary-channel-uuid',
        tenant_id: 'primary',
        agent_id: 'primary',
        external_id: 'default-channel',
        channel_type: 'whatsapp',
        active: true,
      },
    }),
  },
}));

vi.mock('@/gateway/dedup.js', () => ({
  isDuplicate: isDuplicateMock,
  markSeen: markSeenMock,
}));

vi.mock('@/gateway/presence.js', () => ({ markRead: vi.fn() }));

vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: enqueueAgentMock,
  QueueRedisUnavailableError,
}));

vi.mock('@/gateway/debouncer.js', () => ({
  scheduleDebouncedAgent: vi.fn(),
}));

vi.mock('@/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: checkBotAndMaybeBlockMock,
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('@/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));

vi.mock('@/setup/state.js', () => ({
  setupState: {
    current: () => ({ phase: 'connected' }),
    setQr: vi.fn(),
    markPaired: vi.fn(),
    markDisconnected: vi.fn(),
  },
}));

vi.mock('@/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), existsSync: () => true, writeFileSync: vi.fn() };
});

const { startBaileys } = await import('@/gateway/baileys.js');

const fakeTextMsg = () => ({
  key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: 'WAID-IN-OOM' },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'oi maia' },
  pushName: 'Cliente',
});

beforeEach(() => {
  createInboundMock.mockReset();
  createInboundMock.mockResolvedValue({
    row: { id: 'msg-uuid-1', tenant_id: 'primary', agent_id: 'primary' },
    duplicate: false,
  });
  enqueueAgentMock.mockReset();
  enqueueAgentMock.mockResolvedValue(undefined);
  isDuplicateMock.mockResolvedValue(false);
  markSeenMock.mockResolvedValue(undefined);
  checkBotAndMaybeBlockMock.mockResolvedValue(false);
  logWarn.mockClear();
  logError.mockClear();
  handlerState.upsertHandler = null;
});

describe('baileys non-debounced enqueue — OOM fail-closed (#309 / PR #324 B1)', () => {
  it('OOM: handleIncoming catches the typed error, does NOT crash, logs enqueue_failed_fail_closed', async () => {
    enqueueAgentMock.mockRejectedValueOnce(new QueueRedisUnavailableError({ oom: true }));

    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    // Must not reject — the ingress survives the OOM.
    await expect(handlerState.upsertHandler!({ messages: [fakeTextMsg()] })).resolves.toBeUndefined();

    expect(createInboundMock).toHaveBeenCalledTimes(1);
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-uuid-1' });

    const failClosed = logWarn.mock.calls.find((c) => c[1] === 'baileys.enqueue_failed_fail_closed');
    expect(failClosed).toBeTruthy();
    expect(failClosed![0]).toMatchObject({
      mensagem_id: 'msg-uuid-1',
      failure_class: 'redis_unavailable',
      oom: true,
    });
    // The typed error was handled INSIDE handleIncoming — it never reached the
    // outer `baileys.handle_failed` catch.
    const outer = logError.mock.calls.find((c) => c[1] === 'baileys.handle_failed');
    expect(outer).toBeFalsy();
  });

  it('NON-OOM: error is NOT absorbed by the fail-closed branch — propagates to baileys.handle_failed', async () => {
    const boom = Object.assign(new Error('WRONGTYPE Operation against a key'), { name: 'ReplyError' });
    enqueueAgentMock.mockRejectedValueOnce(boom);

    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    // The outer upsert handler catch logs and continues (does not re-throw),
    // so the handler still resolves — but via the GENERIC error path, proving
    // the non-OOM error was NOT swallowed by the OOM-specific fail-closed branch.
    await expect(handlerState.upsertHandler!({ messages: [fakeTextMsg()] })).resolves.toBeUndefined();

    const outer = logError.mock.calls.find((c) => c[1] === 'baileys.handle_failed');
    expect(outer).toBeTruthy();
    // It did NOT take the OOM fail-closed branch.
    const failClosed = logWarn.mock.calls.find((c) => c[1] === 'baileys.enqueue_failed_fail_closed');
    expect(failClosed).toBeFalsy();
  });

  it('happy path: enqueues and logs message.enqueued', async () => {
    await startBaileys();
    await handlerState.upsertHandler!({ messages: [fakeTextMsg()] });
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-uuid-1' });
    expect(logError).not.toHaveBeenCalledWith(expect.anything(), 'baileys.handle_failed');
  });
});
