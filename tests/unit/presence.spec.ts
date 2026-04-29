import { describe, it, expect, vi, beforeEach } from 'vitest';

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
