import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Boom } from '@hapi/boom';

// Capture references the handler will need to interact with. The
// `connection.update` handler lives in `src/gateway/baileys.ts` and is the
// system under test — we exercise it via the `_internal._handleConnectionUpdate`
// seam so we can drive `connection: 'close'` events directly without booting
// the full Baileys pairing flow.

const auditMock = vi.fn().mockResolvedValue(undefined);
const triggerRecoveryMock = vi.fn().mockResolvedValue(undefined);
const useMultiFileAuthStateMock = vi.fn().mockResolvedValue({
  state: {},
  saveCreds: vi.fn(),
});
const makeWASocketMock = vi.fn().mockReturnValue({
  ev: { on: vi.fn() },
  end: vi.fn(),
});
const setupStateMarkDisconnected = vi.fn();
const setupStateMarkPaired = vi.fn();
const setupStateSetQr = vi.fn();
const setupStateCurrent = vi.fn().mockReturnValue({ phase: 'connected' });

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeWASocketMock,
  // Mirror the real numeric values so the handler's
  // `reason === DisconnectReason.loggedOut` check works.
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    loggedOut: 401,
    restartRequired: 515,
  },
  useMultiFileAuthState: useMultiFileAuthStateMock,
  downloadMediaMessage: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-reconnect-test',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/setup/state.js', () => ({
  setupState: {
    current: setupStateCurrent,
    setQr: setupStateSetQr,
    markPaired: setupStateMarkPaired,
    markDisconnected: setupStateMarkDisconnected,
  },
}));

vi.mock('../../src/setup/recovery.js', () => ({
  triggerRecovery: triggerRecoveryMock,
}));

// Quench all the I/O-touching tangents we don't care about for reconnect logic.
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: vi.fn() },
}));
vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn(),
  markSeen: vi.fn(),
}));
vi.mock('../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn() }));
vi.mock('../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn(),
}));
vi.mock('../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));
vi.mock('../../src/agent/message-update.js', () => ({
  routeMessageUpdate: vi.fn(),
}));

beforeEach(() => {
  auditMock.mockClear();
  triggerRecoveryMock.mockClear();
  useMultiFileAuthStateMock.mockClear();
  makeWASocketMock.mockClear();
  setupStateMarkDisconnected.mockClear();
  setupStateMarkPaired.mockClear();
  setupStateSetQr.mockClear();
  setupStateCurrent.mockClear();
  setupStateCurrent.mockReturnValue({ phase: 'connected' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCloseUpdate(reason: number) {
  // Boom shape mirrors what Baileys produces in real `lastDisconnect.error`.
  const err = new Boom('connection closed', { statusCode: reason });
  return { connection: 'close' as const, lastDisconnect: { error: err } };
}

describe('baileys reconnect — exponential backoff on transient close', () => {
  it('reconnectDelayMs: linear ramp capped at 30s', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    expect(mod.reconnectDelayMs(1)).toBe(1000);
    expect(mod.reconnectDelayMs(2)).toBe(2000);
    expect(mod.reconnectDelayMs(5)).toBe(5000);
    expect(mod.reconnectDelayMs(30)).toBe(30000);
    // capped
    expect(mod.reconnectDelayMs(60)).toBe(30000);
    expect(mod.reconnectDelayMs(1000)).toBe(30000);
  });

  it('schedules a reconnect with exponential delay when reason ≠ loggedOut', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._resetReconnectAttempts();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // First close → attempt 1 → 1000ms
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    expect(setupStateMarkDisconnected).toHaveBeenCalledTimes(1);
    expect(triggerRecoveryMock).not.toHaveBeenCalled();
    expect(mod._internal._getReconnectAttempts()).toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]![1]).toBe(1000);

    // Second close → attempt 2 → 2000ms
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    expect(mod._internal._getReconnectAttempts()).toBe(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy.mock.calls[1]![1]).toBe(2000);

    // Third close → attempt 3 → 3000ms
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    expect(mod._internal._getReconnectAttempts()).toBe(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy.mock.calls[2]![1]).toBe(3000);
  });

  it('flips to recovery after RECONNECT_MAX_ATTEMPTS consecutive failures', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._resetReconnectAttempts();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const max = mod._internal.RECONNECT_MAX_ATTEMPTS;
    expect(max).toBeGreaterThan(0);

    // Burn through `max` failures — each schedules a setTimeout.
    for (let i = 0; i < max; i++) {
      await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    }
    expect(setTimeoutSpy).toHaveBeenCalledTimes(max);
    expect(triggerRecoveryMock).not.toHaveBeenCalled();

    // The (max+1)-th close blows the budget → recovery path, no new setTimeout.
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(max);
    expect(triggerRecoveryMock).toHaveBeenCalledTimes(1);
    // Counter is reset so a future open/close cycle starts clean.
    expect(mod._internal._getReconnectAttempts()).toBe(0);
  });

  it('triggers recovery immediately on loggedOut without scheduling a reconnect', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._resetReconnectAttempts();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await mod._internal._handleConnectionUpdate(makeCloseUpdate(401)); // 401 = loggedOut

    expect(triggerRecoveryMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setupStateMarkDisconnected).not.toHaveBeenCalled();
    // Counter must not increment — this is not part of the transient retry path.
    expect(mod._internal._getReconnectAttempts()).toBe(0);
    // Audit trail: pairing_logged_out must be recorded.
    const acaos = auditMock.mock.calls.map((c) => (c[0] as { acao: string }).acao);
    expect(acaos).toContain('pairing_logged_out');
  });

  it('resets the attempt counter on a successful open', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._resetReconnectAttempts();

    // Two failures bump the counter to 2.
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    expect(mod._internal._getReconnectAttempts()).toBe(2);

    // Successful open → counter back to 0.
    await mod._internal._handleConnectionUpdate({ connection: 'open' });
    expect(mod._internal._getReconnectAttempts()).toBe(0);
  });

  it('the scheduled callback ultimately invokes makeWASocket (reconnect path wired)', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._resetReconnectAttempts();
    makeWASocketMock.mockClear();
    useMultiFileAuthStateMock.mockClear();

    await mod._internal._handleConnectionUpdate(makeCloseUpdate(515));
    // setTimeout is mocked by fake timers — fire it.
    await vi.advanceTimersByTimeAsync(2000);

    expect(useMultiFileAuthStateMock).toHaveBeenCalled();
    expect(makeWASocketMock).toHaveBeenCalled();
  });
});
