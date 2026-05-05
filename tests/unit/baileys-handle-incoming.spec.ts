import { describe, it, expect, vi } from 'vitest';

// Mock Redis module before any imports that transitively touch ioredis,
// so the singleton in src/lib/redis.ts never tries to open a real socket
// (which on hosts without Redis emits ECONNREFUSED ::1:6379 noise).
vi.mock('../../src/lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
  },
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn().mockResolvedValue(undefined),
}));

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
  enqueueAgent: vi.fn(),
}));

vi.mock('../../src/governance/audit.js', () => ({
  audit: vi.fn(),
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
