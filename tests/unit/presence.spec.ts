import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// presence.ts pulls in three collaborators: the env config (FEATURE_PRESENCE /
// FEATURE_ONE_TAP), the logger, and the Baileys gateway (isBaileysConnected /
// getSocket). They are mocked ONCE here, at the top level, and their behaviour
// is driven by the mutable `state` object below.
//
// This file used to toggle behaviour per test with `vi.resetModules()` +
// `vi.doMock(...)`. That pattern is order- and timing-dependent: `vi.doMock`
// registrations and the module cache leak across tests, so (a) a test that does
// NOT re-mock can reuse a polluted cached module and (b) two competing
// `doMock`s for the same path (one in a `beforeEach`, one in the test body) do
// not deterministically override which one a later `await import()` resolves.
// The shared spy then flaked: the "Baileys disconnected" startTyping test
// intermittently resolved the *connected* mock and emitted composing/paused
// (the CI failure on node 26), and under shuffled ordering the markRead test
// resolved a disabled mock and skipped its call. The calls are synchronous, so
// this was never a late-timer race — it was nondeterministic mock resolution.
//
// A single stable mock whose functions read the live `state` at call time makes
// every test deterministic regardless of test order or Node version. We keep
// `vi.resetModules()` in `beforeEach` purely for a fresh `handles` map per test;
// the top-level mocks survive `resetModules`, so dependency resolution stays
// fixed.
const { readMessages, sendPresenceUpdate, sendMessage, socket, state } = vi.hoisted(() => {
  const readMessages = vi.fn();
  const sendPresenceUpdate = vi.fn();
  const sendMessage = vi.fn();
  return {
    readMessages,
    sendPresenceUpdate,
    sendMessage,
    socket: { readMessages, sendPresenceUpdate, sendMessage },
    state: { featurePresence: true, featureOneTap: true, connected: true },
  };
});

vi.mock('../../src/config/env.js', () => ({
  config: {
    get FEATURE_PRESENCE() {
      return state.featurePresence;
    },
    get FEATURE_ONE_TAP() {
      return state.featureOneTap;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => state.connected,
  getSocket: () => (state.connected ? socket : null),
}));

beforeEach(() => {
  // The socket calls in presence.ts chain `.catch(...)`, so the spies must
  // return a thenable.
  readMessages.mockReset().mockResolvedValue(undefined);
  sendPresenceUpdate.mockReset().mockResolvedValue(undefined);
  sendMessage.mockReset().mockResolvedValue(undefined);
  state.featurePresence = true;
  state.featureOneTap = true;
  state.connected = true;
  // Fresh module instance per test ⇒ a clean `handles` map and no typing
  // intervals left over from a prior test.
  vi.resetModules();
});

describe('presence — markRead', () => {
  it('calls socket.readMessages with the constructed key', async () => {
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('5511999@s.whatsapp.net', 'WAID-123');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '5511999@s.whatsapp.net', id: 'WAID-123', fromMe: false },
    ]);
  });

  it('is a no-op when FEATURE_PRESENCE is false', async () => {
    state.featurePresence = false;
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when Baileys is disconnected', async () => {
    state.connected = false;
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });
});

describe('presence — startTyping', () => {
  it('emits "composing" once on start and "paused" on stop', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const jid = '5511999998881@s.whatsapp.net';
    const handle = startTyping(jid, 'inbound-1');
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('composing', jid);
    handle.stop();
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('paused', jid);
  });

  it('returns the same handle for the same mensagem_id', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const jid = '5511999998882@s.whatsapp.net';
    const a = startTyping(jid, 'inbound-X');
    const b = startTyping(jid, 'inbound-X');
    expect(a).toBe(b);
    a.stop();
  });

  it('handle.stop() is idempotent', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('5511999998883@s.whatsapp.net', 'inbound-Y');
    handle.stop();
    handle.stop();
    await new Promise((r) => setImmediate(r));
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls).toHaveLength(1);
  });

  it('returns no-op handle when FEATURE_PRESENCE is false', async () => {
    state.featurePresence = false;
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'm1');
    handle.stop();
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it('returns no-op handle when Baileys is disconnected', async () => {
    state.connected = false;
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('5511999@s.whatsapp.net', 'inbound-disconnected');
    handle.stop();
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });
});

describe('presence — JID validation', () => {
  it('validJid accepts canonical individual and group JIDs', async () => {
    const { _internal } = await import('../../src/gateway/presence.js');
    expect(_internal.validJid('5511999998888@s.whatsapp.net')).toBe(true);
    expect(_internal.validJid('120363041234567890@g.us')).toBe(true);
  });

  it('validJid rejects malformed inputs', async () => {
    const { _internal } = await import('../../src/gateway/presence.js');
    expect(_internal.validJid('not-a-jid')).toBe(false);
    expect(_internal.validJid('@s.whatsapp.net')).toBe(false);
    expect(_internal.validJid('5511999998888@example.com')).toBe(false);
    expect(_internal.validJid('5511999998888')).toBe(false);
    expect(_internal.validJid('')).toBe(false);
  });

  it('markRead skips socket call on invalid JID', async () => {
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('not-a-jid', 'WAID-1');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('startTyping returns NOOP on invalid JID', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('garbage', 'inbound-bad');
    handle.stop();
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it('sendReaction skips socket call on invalid JID', async () => {
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('garbage', 'WAID-1', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('quotedReplyContext returns undefined for invalid remote_jid', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ whatsapp_id: 'W1', remote_jid: 'bogus' }, 'msg')).toBeUndefined();
  });
});

describe('presence — leak safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('sweep stops handles older than 5 min', async () => {
    const { startTyping, _internal } = await import('../../src/gateway/presence.js');
    const handle = startTyping('5511999998884@s.whatsapp.net', 'old-msg');
    vi.advanceTimersByTime(6 * 60 * 1000);
    _internal.runStaleSweep();
    handle.stop();
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls.length).toBe(1);
  });
});

describe('presence — sendReaction', () => {
  it('sends a react payload anchored to (remote_jid, whatsapp_id)', async () => {
    const { sendReaction } = await import('../../src/gateway/presence.js');
    const jid = '5511999998885@s.whatsapp.net';
    sendReaction(jid, 'WAID-9', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).toHaveBeenCalledWith(jid, {
      react: { text: '✅', key: { remoteJid: jid, id: 'WAID-9', fromMe: false } },
    });
  });

  it('no-op when disconnected', async () => {
    state.connected = false;
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('jid', 'id', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('presence — quotedReplyContext', () => {
  it('builds a context from inbound metadata + truncates to 200 chars', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    const remote_jid = '5511999998886@s.whatsapp.net';
    const meta = { whatsapp_id: 'W1', remote_jid };
    const long = 'x'.repeat(500);
    const ctx = quotedReplyContext(meta, long);
    expect(ctx).toEqual({
      key: { remoteJid: remote_jid, id: 'W1', fromMe: false },
      message: { conversation: 'x'.repeat(200) },
    });
  });

  it('returns undefined when metadata lacks whatsapp_id', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ remote_jid: '5511999998887@s.whatsapp.net' }, 'x')).toBeUndefined();
  });

  it('returns undefined when metadata lacks remote_jid', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ whatsapp_id: 'W1' }, 'x')).toBeUndefined();
  });

  it('returns undefined for null metadata', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext(null, 'x')).toBeUndefined();
  });
});
