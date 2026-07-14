/**
 * §1.4 do roteamento (spec v4, §5 testes) — staging de inbound não-roteado:
 *   - estagiar SEMPRE re-arma o job (insert novo OU conflito/retry — jobId
 *     estável torna o re-add idempotente): o retry nunca conclui sem job vivo;
 *   - replay decifra e entrega pela pipeline normal; entregou ⇒ CAS
 *     handed_off + audit; sem rota ainda ⇒ throw (BullMQ reagenda);
 *   - row não-pending/expirada ⇒ no-op idempotente (corrida com o caminho
 *     vivo resolve no dedup por canal, nunca em dupla entrega).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const KEY = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(32).toString('base64');
});

const { repoMock, enqueueMock, ingressMock, auditMock } = vi.hoisted(() => ({
  repoMock: {
    stage: vi.fn(),
    findById: vi.fn(),
    markHandedOff: vi.fn(),
    bumpAttempts: vi.fn(async () => undefined),
    listPendingStale: vi.fn(),
    expireOverdue: vi.fn(),
    listPendingKeyIds: vi.fn(),
  },
  enqueueMock: vi.fn(async () => undefined),
  ingressMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    MAIA_STAGING_KEYRING: JSON.stringify({ k1: KEY }),
    MAIA_STAGING_ACTIVE_KEY_ID: 'k1',
    MAIA_CHANNEL_ROUTING_MODE: 'strict',
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/db/repositories/inbound-unrouted-repos.js', () => ({
  inboundUnroutedRepo: repoMock,
}));
vi.mock('../../src/gateway/queue.js', () => ({ enqueueUnroutedReplay: enqueueMock }));
vi.mock('../../src/gateway/baileys.js', () => ({ ingressUpsertMessage: ingressMock }));

import {
  stageUnroutedInbound,
  processUnroutedReplay,
  encodeStagedMessage,
  decodeStagedMessage,
} from '../../src/gateway/unrouted-staging.js';
import { parseKeyring, sealEnvelope } from '../../src/gateway/staging-crypto.js';

const MSG = {
  key: { id: 'WID-1', remoteJid: '5511977776666@s.whatsapp.net' },
  message: { conversation: 'oi' },
  messageTimestamp: 1751234567,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stageUnroutedInbound — sem janela de perda Postgres→BullMQ', () => {
  it('sela com a chave ativa, estagia e ARMA o job; audita inbound_staged', async () => {
    repoMock.stage.mockResolvedValueOnce({ id: 'u-1', already_staged: false });
    const ok = await stageUnroutedInbound(MSG, '+5511900001111');
    expect(ok).toBe(true);
    const stageArgs = repoMock.stage.mock.calls[0]![0] as {
      line_external_id: string;
      whatsapp_message_id: string;
      envelope: Buffer;
      enc_key_id: string;
    };
    expect(stageArgs.line_external_id).toBe('+5511900001111');
    expect(stageArgs.whatsapp_message_id).toBe('WID-1');
    expect(stageArgs.enc_key_id).toBe('k1');
    expect(Buffer.isBuffer(stageArgs.envelope)).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith({
      unrouted_id: 'u-1',
      line_external_id: '+5511900001111',
      whatsapp_message_id: 'WID-1',
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'inbound_staged' }),
    );
  });

  it('CONFLITO (retry do evento) devolve a MESMA row e RE-ARMA o job mesmo assim', async () => {
    repoMock.stage.mockResolvedValueOnce({ id: 'u-1', already_staged: true });
    const ok = await stageUnroutedInbound(MSG, '+5511900001111');
    expect(ok).toBe(true);
    // O retry nunca conclui sem garantir job vivo (§1.4 bloqueante 3).
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('falha no staging retorna false (o audit de drop do resolver permanece)', async () => {
    repoMock.stage.mockRejectedValueOnce(new Error('db down'));
    const ok = await stageUnroutedInbound(MSG, '+5511900001111');
    expect(ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe('processUnroutedReplay — handoff idempotente', () => {
  function sealedRow(overrides: Record<string, unknown> = {}) {
    const keyring = parseKeyring(JSON.stringify({ k1: KEY }), 'k1');
    return {
      id: 'u-1',
      line_external_id: '+5511900001111',
      whatsapp_message_id: 'WID-1',
      envelope: sealEnvelope(encodeStagedMessage(MSG), keyring),
      enc_key_id: 'k1',
      status: 'pending',
      attempts: 0,
      received_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
      handed_off_at: null,
      ...overrides,
    };
  }

  it('decifra, entrega pela pipeline com a LINHA original e marca handed_off', async () => {
    repoMock.findById.mockResolvedValueOnce(sealedRow());
    ingressMock.mockResolvedValueOnce('handled');
    repoMock.markHandedOff.mockResolvedValueOnce(true);

    await processUnroutedReplay('u-1');

    const [deliveredMsg, lineCtx] = ingressMock.mock.calls[0]!;
    expect((deliveredMsg as { key: { id: string } }).key.id).toBe('WID-1');
    expect(lineCtx).toEqual({ botLineE164: '+5511900001111' });
    expect(repoMock.markHandedOff).toHaveBeenCalledWith('u-1');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'inbound_unrouted_handed_off' }),
    );
  });

  it('ainda sem rota (dropped) ⇒ lança para o BullMQ reagendar; row segue pending', async () => {
    repoMock.findById.mockResolvedValueOnce(sealedRow());
    ingressMock.mockResolvedValueOnce('dropped');
    await expect(processUnroutedReplay('u-1')).rejects.toThrow(
      'unrouted_replay_not_delivered',
    );
    expect(repoMock.markHandedOff).not.toHaveBeenCalled();
  });

  it('row já handed_off ⇒ no-op (replay duplicado nunca re-entrega)', async () => {
    repoMock.findById.mockResolvedValueOnce(sealedRow({ status: 'handed_off' }));
    await processUnroutedReplay('u-1');
    expect(ingressMock).not.toHaveBeenCalled();
  });

  it('row vencida ⇒ no-op (o sweeper expira e audita)', async () => {
    repoMock.findById.mockResolvedValueOnce(
      sealedRow({ expires_at: new Date(Date.now() - 1000) }),
    );
    await processUnroutedReplay('u-1');
    expect(ingressMock).not.toHaveBeenCalled();
  });
});

describe('encode/decodeStagedMessage — codec protobuf preserva mídia (review #496 alto 3)', () => {
  it('roundtrip de imagem/áudio/documento mantém os campos binários byte a byte', () => {
    const mediaKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const fileSha256 = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const fileEncSha256 = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 256);
    const jpegThumbnail = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const media = {
      key: { id: 'WID-MEDIA', remoteJid: '5511977776666@s.whatsapp.net' },
      messageTimestamp: 1751234567,
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/x',
          mimetype: 'image/jpeg',
          mediaKey,
          fileSha256,
          fileEncSha256,
          fileLength: 12345,
          jpegThumbnail,
        },
      },
    };
    const decoded = decodeStagedMessage(encodeStagedMessage(media as never));

    const img = decoded.message!.imageMessage!;
    // JSON.stringify degradava estes campos em `{0: .., 1: ..}` — o codec
    // proto devolve Uint8Array com os MESMOS bytes (chaves de decrypt e
    // hashes de validação chegariam inválidos à pipeline de mídia).
    expect(Buffer.from(img.mediaKey!)).toEqual(Buffer.from(mediaKey));
    expect(Buffer.from(img.fileSha256!)).toEqual(Buffer.from(fileSha256));
    expect(Buffer.from(img.fileEncSha256!)).toEqual(Buffer.from(fileEncSha256));
    expect(Buffer.from(img.jpegThumbnail!)).toEqual(Buffer.from(jpegThumbnail));
    expect(decoded.key!.id).toBe('WID-MEDIA');
    expect(Number(decoded.messageTimestamp)).toBe(1751234567);
  });

  it('aceita tanto instância proto viva quanto objeto estrutural', async () => {
    const { proto } = await import('@whiskeysockets/baileys');
    const live = proto.WebMessageInfo.fromObject({
      key: { id: 'WID-LIVE' },
      message: { conversation: 'oi' },
    });
    const decoded = decodeStagedMessage(encodeStagedMessage(live));
    expect(decoded.key!.id).toBe('WID-LIVE');
    expect(decoded.message!.conversation).toBe('oi');
  });
});
