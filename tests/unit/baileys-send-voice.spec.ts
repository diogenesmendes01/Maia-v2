import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-baileys-voice-test-' + Date.now());

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

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys'),
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_PDF_REPORTS: false,
    FEATURE_OUTBOUND_VOICE: true,
  },
}));

beforeEach(async () => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ key: { id: 'WAID-VOICE-1' } });
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});

afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

describe('sendOutboundVoice', () => {
  it('passes { audio: Buffer, mimetype, ptt: true } to socket.sendMessage', async () => {
    const buf = Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00]); // 'OggS\0' fake
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const wid = await mod.sendOutboundVoice('5511999999999@s.whatsapp.net', buf);
    expect(wid).toBe('WAID-VOICE-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jidArg, contentArg, miscArg] = sendMessage.mock.calls[0]!;
    expect(jidArg).toBe('5511999999999@s.whatsapp.net');
    expect(contentArg).toMatchObject({
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    expect(Buffer.isBuffer(contentArg.audio)).toBe(true);
    expect(contentArg.audio.length).toBe(5);
    expect(miscArg).toBeUndefined();
  });

  it('forwards quoted as third arg when provided', async () => {
    const buf = Buffer.from([0x4F, 0x67]);
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const quoted = { key: { id: 'WAID-IN' } } as never;
    await mod.sendOutboundVoice('jid', buf, { quoted });
    const [, , miscArg] = sendMessage.mock.calls[0]!;
    expect(miscArg).toEqual({ quoted });
  });

  it('returns null when not connected; sendMessage NOT called', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod._internal._setSocketForTests(null, false);
    const wid = await mod.sendOutboundVoice('jid', Buffer.from([0]));
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
