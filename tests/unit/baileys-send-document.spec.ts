import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-baileys-doc-test-' + Date.now());

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

// Mock the redis-touching transitive modules so importing baileys.ts
// doesn't try to open a TCP connection to localhost:6379. The unit suite
// runs without a live Redis; without these stubs the module-load chain
// (baileys → queue → ioredis, baileys → bot-detection → redis) emits
// ECONNREFUSED stderr noise even when tests pass.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  markSeen: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(SANDBOX, '.baileys'),
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_PDF_REPORTS: true,
  },
}));

beforeEach(async () => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ key: { id: 'WAID-DOC-1' } });
  await mkdir(join(SANDBOX, '.baileys'), { recursive: true });
  await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
});

afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

// #545: o grafo de `src/gateway/baileys.js` custa 5.77–6.83s para carregar a
// frio, contra 2–11ms de trabalho real por caso. Quando o prazo estourava, o
// corpo órfão chamava `sendMessage` de novo e o retry morria com
// `expected "vi.fn()" to be called 1 times, but got 2 times"`.
const baileys = moduloDeProducao(() => import('../../src/gateway/baileys.js'));

describe('sendOutboundDocument', () => {
  it('passes { document: Buffer, mimetype, fileName, caption } to socket.sendMessage', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'sample.pdf');
    await writeFile(path, '%PDF-1.4 sample bytes\n%%EOF');
    const mod = baileys();
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const wid = await mod.sendOutboundDocument('5511999999999@s.whatsapp.net', path, {
      mimetype: 'application/pdf',
      fileName: 'extrato-teste-2026-04.pdf',
      caption: 'Aqui está o extrato',
    });
    expect(wid).toBe('WAID-DOC-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jidArg, contentArg, miscArg] = sendMessage.mock.calls[0]!;
    expect(jidArg).toBe('5511999999999@s.whatsapp.net');
    expect(contentArg).toMatchObject({
      mimetype: 'application/pdf',
      fileName: 'extrato-teste-2026-04.pdf',
      caption: 'Aqui está o extrato',
    });
    expect(Buffer.isBuffer(contentArg.document)).toBe(true);
    expect(miscArg).toBeUndefined();
  });

  it('forwards quoted as third arg when provided', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'q.pdf');
    await writeFile(path, '%PDF-1.4');
    const mod = baileys();
    mod._internal._setSocketForTests(fakeSocket as never, true);
    const quoted = { key: { id: 'WAID-IN' } } as never;
    await mod.sendOutboundDocument('jid', path, {
      mimetype: 'application/pdf', fileName: 'q.pdf', quoted,
    });
    const [, , miscArg] = sendMessage.mock.calls[0]!;
    expect(miscArg).toEqual({ quoted });
  });

  it('returns null when not connected; sendMessage NOT called', async () => {
    const path = join(SANDBOX, 'media', 'tmp', 'nc.pdf');
    await writeFile(path, '%PDF-1.4');
    const mod = baileys();
    mod._internal._setSocketForTests(null, false);
    const wid = await mod.sendOutboundDocument('jid', path, {
      mimetype: 'application/pdf', fileName: 'nc.pdf',
    });
    expect(wid).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('THROWS and logs error when readFile fails (file vanished); sendMessage NOT called', async () => {
    // Read failure is BEFORE the send → nothing left the channel. Throwing (not
    // returning null) lets the PDF dispatch tag it delivered:false instead of
    // mistaking a connected read-failure for a sent-without-id (Codex #216 round-4).
    const mod = baileys();
    mod._internal._setSocketForTests(fakeSocket as never, true);
    await expect(
      mod.sendOutboundDocument('jid', '/no/such/file.pdf', {
        mimetype: 'application/pdf', fileName: 'gone.pdf',
      }),
    ).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
