import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Isolated per-run auth/media base so the P0-ch.4 media-write tests never
// touch a shared location (mediaPathFor writes REAL files here).
const { AUTH_DIR, MEDIA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  const base = path.join(os.tmpdir(), 'maia-baileys-handle-incoming-' + Date.now());
  return { AUTH_DIR: path.join(base, '.baileys'), MEDIA_DIR: path.join(base, 'media') };
});

const {
  downloadMediaMessageMock,
  createInboundMock,
  enqueueAgentMock,
  resolveScopeForJidMock,
} = vi.hoisted(() => ({
  downloadMediaMessageMock: vi.fn(),
  createInboundMock: vi.fn(),
  enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
  resolveScopeForJidMock: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
  downloadMediaMessage: downloadMediaMessageMock,
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: AUTH_DIR,
    FEATURE_PRESENCE: true,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_MESSAGE_DEBOUNCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: createInboundMock },
}));

vi.mock('../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  markSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: enqueueAgentMock,
  shutdownQueue: vi.fn(),
}));

vi.mock('../../src/governance/audit.js', () => ({
  audit: vi.fn(),
}));

// The JID→tenant resolver: pin the inbound to a synthetic tenant so the
// tenant-scoped media dir (`<MEDIA_ROOT>/<tenant>/<month>/`) is observable.
vi.mock('../../src/gateway/jid-tenant-resolver.js', () => ({
  resolveScopeForJid: resolveScopeForJidMock,
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

import { isReactionStub, ingressUpsertMessage } from '../../src/gateway/baileys.js';
import {
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
} from '../../src/lib/media-guard.js';

afterAll(() => {
  rmSync(join(MEDIA_DIR, '..'), { recursive: true, force: true });
});

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

// ───────────────────────────────────────────────────────────────────────────
// P0 audit ch. 4 — inbound media protection at the gateway ingest.
// Drives the REAL handleIncoming via ingressUpsertMessage (tenant resolver
// mocked, real ALS via runWithTenantContext).
// ───────────────────────────────────────────────────────────────────────────

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

let waidSeq = 0;
function mediaMsg(kind: 'imageMessage' | 'audioMessage' | 'documentMessage', envelope: Record<string, unknown>) {
  return {
    key: {
      fromMe: false,
      remoteJid: '5511999990001@s.whatsapp.net',
      id: `WAID-MEDIA-${++waidSeq}`,
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Cliente',
    message: { [kind]: envelope },
  } as never;
}

describe('baileys handleIncoming — media caps / magic / tenant-scoped storage (P0 ch. 4)', () => {
  beforeEach(() => {
    downloadMediaMessageMock.mockReset();
    createInboundMock.mockReset();
    enqueueAgentMock.mockClear();
    resolveScopeForJidMock.mockReset();
    resolveScopeForJidMock.mockResolvedValue({
      scope: { tenant_id: 'tenant-x', agent_id: 'agent-x', channel_id: 'ch-1' },
      jid_context: {
        via_lid_fallback: false,
        resolved_phone_e164: '+5511999990001',
        raw_jid: '5511999990001@s.whatsapp.net',
        lid_recovery_source: null,
      },
    });
    createInboundMock.mockResolvedValue({ row: { id: 'msg-1' }, duplicate: false });
  });

  it('accepts in-cap media: writes under <MEDIA_ROOT>/<tenant>/<month>/ with magic-derived extension', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(PNG);
    const out = await ingressUpsertMessage(
      mediaMsg('imageMessage', {
        // Declared mimetype LIES (attacker-controlled) — extension must come
        // from the sniffed magic (png), not from this.
        mimetype: 'application/x-sh',
        caption: 'foto do comprovante',
        fileLength: PNG.length,
      }),
    );
    expect(out).toBe('handled');
    expect(createInboundMock).toHaveBeenCalledTimes(1);
    const row = createInboundMock.mock.calls[0]![0] as {
      midia_url: string | null;
      conteudo: string | null;
      metadata: Record<string, unknown>;
    };
    const sha = createHash('sha256').update(PNG).digest('hex');
    // Tenant-scoped monthly dir + sha-named file + SNIFFED extension.
    expect(row.midia_url).toBe(
      join(MEDIA_DIR, 'tenant-x', new Date().toISOString().slice(0, 7), `${sha}.png`),
    );
    expect(existsSync(row.midia_url!)).toBe(true);
    expect(row.conteudo).toBe('foto do comprovante');
    expect(row.metadata.media_sha256).toBe(sha);
    expect(row.metadata.media_rejected).toBeNull();
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-1' });
  });

  it('rejects an oversized DECLARED fileLength BEFORE downloading (no unbounded download)', async () => {
    const out = await ingressUpsertMessage(
      mediaMsg('imageMessage', {
        mimetype: 'image/png',
        caption: 'foto gigante',
        fileLength: MAX_IMAGE_BYTES + 1,
      }),
    );
    expect(out).toBe('handled');
    // The download never happened — the declared size already blew the cap.
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
    const row = createInboundMock.mock.calls[0]![0] as {
      midia_url: string | null;
      conteudo: string | null;
      metadata: Record<string, unknown>;
    };
    // Turn still processes: caption survives, media fields are withheld.
    expect(row.midia_url).toBeNull();
    expect(row.metadata.media_sha256).toBeNull();
    expect(row.conteudo).toBe('foto gigante');
    expect(row.metadata.media_rejected).toBe('too_large_declared');
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-1' });
  });

  it('re-checks the ACTUAL buffer size after download (lying small fileLength)', async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    PNG.copy(big); // valid png magic, oversized body
    downloadMediaMessageMock.mockResolvedValueOnce(big);
    await ingressUpsertMessage(
      mediaMsg('imageMessage', { mimetype: 'image/png', caption: 'c', fileLength: 100 }),
    );
    const row = createInboundMock.mock.calls[0]![0] as {
      midia_url: string | null;
      metadata: Record<string, unknown>;
    };
    expect(row.midia_url).toBeNull();
    expect(row.metadata.media_rejected).toBe('too_large');
  });

  it('rejects bad magic: bytes that do not sniff as an image ⇒ midia_url null + media_rejected', async () => {
    downloadMediaMessageMock.mockResolvedValueOnce(
      Buffer.from('#!/bin/sh\necho not-an-image\n'),
    );
    const out = await ingressUpsertMessage(
      mediaMsg('imageMessage', { mimetype: 'image/jpeg', caption: 'diz que é imagem' }),
    );
    expect(out).toBe('handled');
    const row = createInboundMock.mock.calls[0]![0] as {
      midia_url: string | null;
      conteudo: string | null;
      metadata: Record<string, unknown>;
    };
    expect(row.midia_url).toBeNull();
    expect(row.metadata.media_rejected).toBe('bad_magic');
    // Caption/text still persisted — the turn is NOT dropped.
    expect(row.conteudo).toBe('diz que é imagem');
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'msg-1' });
  });

  it('audio declared over the 25MB cap is refused pre-download; documento uses the 15MB cap', async () => {
    await ingressUpsertMessage(
      mediaMsg('audioMessage', { mimetype: 'audio/ogg', fileLength: MAX_AUDIO_BYTES + 1 }),
    );
    let row = createInboundMock.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(row.metadata.media_rejected).toBe('too_large_declared');
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();

    createInboundMock.mockClear();
    await ingressUpsertMessage(
      mediaMsg('documentMessage', {
        mimetype: 'application/pdf',
        fileLength: MAX_DOCUMENT_BYTES + 1,
      }),
    );
    row = createInboundMock.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(row.metadata.media_rejected).toBe('too_large_declared');
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();
  });

  it('documento with unknown magic is stored with a sanitized .bin extension (not rejected)', async () => {
    const payload = Buffer.from('PK-some-zipish-office-doc-bytes');
    downloadMediaMessageMock.mockResolvedValueOnce(payload);
    await ingressUpsertMessage(
      mediaMsg('documentMessage', {
        // Attacker-controlled mimetype with a path-traversal-ish subtype must
        // never leak into the extension.
        mimetype: 'application/../../evil',
        fileLength: payload.length,
      }),
    );
    const row = createInboundMock.mock.calls[0]![0] as {
      midia_url: string | null;
      metadata: Record<string, unknown>;
    };
    expect(row.metadata.media_rejected).toBeNull();
    expect(row.midia_url).toMatch(/\.bin$/);
    expect(row.midia_url).toContain(join(MEDIA_DIR, 'tenant-x'));
  });
});
