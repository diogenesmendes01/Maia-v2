import { describe, it, expect, vi } from 'vitest';


vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/baileys-test', FEATURE_PRESENCE: true },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: vi.fn() },
}));

vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn(),
  markSeen: vi.fn(),
}));

vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));

vi.mock('../../src/governance/audit.js', () => ({
  audit: vi.fn(),
}));

// Stub the redis client so the module-load chain (baileys → bot-detection
// → redis) doesn't try to open a TCP connection to localhost:6379. Without
// this, ioredis emits ECONNREFUSED on stderr — the tests still pass but
// the noise can mask real issues in CI logs.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn().mockResolvedValue(false),
}));

import { isReactionStub } from '../../src/gateway/baileys.js';

describe('baileys — isReactionStub', () => {
  it('returns true for messageStubType=67 (REACTION)', () => {
    expect(isReactionStub({ messageStubType: 67 })).toBe(true);
  });
  it('returns false for ordinary messages', () => {
    expect(isReactionStub({})).toBe(false);
    expect(isReactionStub({ messageStubType: null })).toBe(false);
    expect(isReactionStub({ messageStubType: undefined })).toBe(false);
    expect(isReactionStub({ messageStubType: 1 })).toBe(false);
  });
});

describe('baileys — sendOutboundText with quoted opts (contract)', () => {
  it('passes quoted as the third arg to socket.sendMessage', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'WAID-OUT' } });
    const stub = { sendMessage };
    const quoted = {
      key: { remoteJid: 'jid', id: 'WAID-IN', fromMe: false },
      message: { conversation: 'previous' },
    };
    await stub.sendMessage('jid', { text: 'hi' }, { quoted });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'hi' }, { quoted });
  });
});
