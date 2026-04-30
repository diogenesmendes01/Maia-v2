import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const fakeSocket = { sendMessage };

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
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

// Default: feature flag ON for these tests; individual tests override.
let viewOnceFlag = true;
vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: './.baileys-auth-test',
    get FEATURE_VIEW_ONCE_SENSITIVE() {
      return viewOnceFlag;
    },
  },
}));

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ key: { id: 'WAID-OUT-1' } });
  viewOnceFlag = true;
});

// `sendOutboundText` reads the module-level `socket` and `connected`. To
// drive it from tests without booting the full WA pairing flow, we use a
// test-only `_internal._setSocketForTests` seam (added to baileys.ts in
// Step 3 of this task). This Step 1 test will fail because the seam doesn't
// exist yet — that's the TDD red.

describe('sendOutboundText — view_once envelope contract', () => {
  it('passes { text, viewOnce: true } when opts.view_once && FEATURE_VIEW_ONCE_SENSITIVE', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('5511999999999@s.whatsapp.net', 'Saldo R$ 1.234', { view_once: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      { text: 'Saldo R$ 1.234', viewOnce: true },
      undefined,
    );
  });

  it('does NOT pass viewOnce when FEATURE_VIEW_ONCE_SENSITIVE is false', async () => {
    viewOnceFlag = false;
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('jid', 'Saldo', { view_once: true });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'Saldo' }, undefined);
  });

  it('does NOT pass viewOnce when opts.view_once is false even with flag on', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await mod.sendOutboundText('jid', 'Saldo', { view_once: false });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'Saldo' }, undefined);
  });

  it('view_once + quoted forwards both', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const quoted = { key: { id: 'WAID-IN' } } as never;
    await mod.sendOutboundText('jid', 'R$ x', { view_once: true, quoted });
    expect(sendMessage).toHaveBeenCalledWith('jid', { text: 'R$ x', viewOnce: true }, { quoted });
  });

  it('returns null when not connected (existing behaviour preserved)', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(null, false);
    const wid = await mod.sendOutboundText('jid', 'whatever', { view_once: true });
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
