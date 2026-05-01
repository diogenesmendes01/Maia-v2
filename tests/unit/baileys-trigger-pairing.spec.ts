import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestPairingCode = vi.fn();

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => ({}),
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/maia-trigger-pairing-test' },
}));

beforeEach(() => {
  requestPairingCode.mockReset();
  requestPairingCode.mockResolvedValue('12345678');
});

describe('triggerPairingCode — JID/phone normalization', () => {
  it('strips leading "+" before calling socket.requestPairingCode', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests({ requestPairingCode } as never, true);
    const code = await mod.triggerPairingCode('+5511999999999');
    expect(code).toBe('12345678');
    expect(requestPairingCode).toHaveBeenCalledTimes(1);
    expect(requestPairingCode).toHaveBeenCalledWith('5511999999999');
  });

  it('passes a number without "+" through unchanged', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests({ requestPairingCode } as never, true);
    await mod.triggerPairingCode('5511999999999');
    expect(requestPairingCode).toHaveBeenCalledWith('5511999999999');
  });

  it('throws baileys_socket_not_ready when socket is null', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(null, false);
    await expect(mod.triggerPairingCode('+5511999999999')).rejects.toThrow(
      'baileys_socket_not_ready',
    );
    expect(requestPairingCode).not.toHaveBeenCalled();
  });
});
