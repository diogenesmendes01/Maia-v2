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
