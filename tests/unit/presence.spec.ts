import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readMessages = vi.fn().mockResolvedValue(undefined);
const sendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
const sendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => true,
  getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PRESENCE: true },
}));

beforeEach(() => {
  readMessages.mockReset().mockResolvedValue(undefined);
  sendPresenceUpdate.mockReset().mockResolvedValue(undefined);
  sendMessage.mockReset().mockResolvedValue(undefined);
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
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: false } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when Baileys is disconnected', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => false,
      getSocket: () => null,
    }));
    const { markRead } = await import('../../src/gateway/presence.js');
    markRead('jid', 'id');
    await new Promise((r) => setImmediate(r));
    expect(readMessages).not.toHaveBeenCalled();
  });
});

describe('presence — startTyping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });

  it('emits "composing" once on start and "paused" on stop', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid-1', 'inbound-1');
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('composing', 'jid-1');
    handle.stop();
    await new Promise((r) => setImmediate(r));
    expect(sendPresenceUpdate).toHaveBeenCalledWith('paused', 'jid-1');
  });

  it('returns the same handle for the same mensagem_id', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const a = startTyping('jid', 'inbound-X');
    const b = startTyping('jid', 'inbound-X');
    expect(a).toBe(b);
    a.stop();
  });

  it('handle.stop() is idempotent', async () => {
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'inbound-Y');
    handle.stop();
    handle.stop();
    await new Promise((r) => setImmediate(r));
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls).toHaveLength(1);
  });

  it('returns no-op handle when FEATURE_PRESENCE is false', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: false } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
    const { startTyping } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'm1');
    handle.stop();
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });
});

describe('presence — leak safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('sweep stops handles older than 5 min', async () => {
    const { startTyping, _internal } = await import('../../src/gateway/presence.js');
    const handle = startTyping('jid', 'old-msg');
    vi.advanceTimersByTime(6 * 60 * 1000);
    _internal.runStaleSweep();
    handle.stop();
    const pausedCalls = sendPresenceUpdate.mock.calls.filter((c) => c[0] === 'paused');
    expect(pausedCalls.length).toBe(1);
  });
});

describe('presence — sendReaction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => true,
      getSocket: () => ({ readMessages, sendPresenceUpdate, sendMessage }),
    }));
  });

  it('sends a react payload anchored to (remote_jid, whatsapp_id)', async () => {
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('jid', 'WAID-9', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).toHaveBeenCalledWith('jid', {
      react: { text: '✅', key: { remoteJid: 'jid', id: 'WAID-9', fromMe: false } },
    });
  });

  it('no-op when disconnected', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({ config: { FEATURE_PRESENCE: true } }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/gateway/baileys.js', () => ({
      isBaileysConnected: () => false,
      getSocket: () => null,
    }));
    const { sendReaction } = await import('../../src/gateway/presence.js');
    sendReaction('jid', 'id', '✅');
    await new Promise((r) => setImmediate(r));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('presence — quotedReplyContext', () => {
  it('builds a context from inbound metadata + truncates to 200 chars', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    const meta = { whatsapp_id: 'W1', remote_jid: 'J1' };
    const long = 'x'.repeat(500);
    const ctx = quotedReplyContext(meta, long);
    expect(ctx).toEqual({
      key: { remoteJid: 'J1', id: 'W1', fromMe: false },
      message: { conversation: 'x'.repeat(200) },
    });
  });

  it('returns undefined when metadata lacks whatsapp_id', async () => {
    const { quotedReplyContext } = await import('../../src/gateway/presence.js');
    expect(quotedReplyContext({ remote_jid: 'J1' }, 'x')).toBeUndefined();
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
