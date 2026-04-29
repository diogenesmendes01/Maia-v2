import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappIdMock = vi.fn();
const auditLogQueryMock = vi.fn();
const findOwnerByPhoneMock = vi.fn();
const findActiveConversaMock = vi.fn();
const pendingCreateTxMock = vi.fn();
const pendingCancelOpenForConversaTxMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId: findByWhatsappIdMock },
  auditRepo: { findByMensagemId: auditLogQueryMock },
  pessoasRepo: { findByPhone: findOwnerByPhoneMock },
  conversasRepo: { findActive: findActiveConversaMock },
  pendingQuestionsRepo: {
    createTx: pendingCreateTxMock,
    cancelOpenForConversaTx: pendingCancelOpenForConversaTxMock,
  },
}));

const withTxMock = vi.fn(async (fn) => fn({} as never));
vi.mock('../../src/db/client.js', () => ({ withTx: withTxMock, db: {} as never }));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_MESSAGE_UPDATE: true, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappIdMock.mockReset();
  auditLogQueryMock.mockReset();
  findOwnerByPhoneMock.mockReset();
  findActiveConversaMock.mockReset();
  pendingCreateTxMock.mockReset();
  pendingCancelOpenForConversaTxMock.mockReset();
  pendingCancelOpenForConversaTxMock.mockResolvedValue({ cancelled_ids: [] });
  auditMock.mockReset();
  withTxMock.mockClear();
});

describe('routeMessageUpdate — edit, no side-effect', () => {
  it('audits mensagem_edited with diff when no side-effect found', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50 mercado',
    });
    auditLogQueryMock.mockResolvedValueOnce([]);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: {
        editedMessage: { message: { conversation: 'lança 50 mercados' } },
      },
    } as never);
    const edited = auditMock.mock.calls.filter((c) => c[0].acao === 'mensagem_edited');
    expect(edited).toHaveLength(1);
    expect(edited[0][0].diff).toEqual({ before: 'lança 50 mercado', after: 'lança 50 mercados' });
    expect(pendingCreateTxMock).not.toHaveBeenCalled();
  });

  it('returns silently when original mensagem not found', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce(null);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-unknown', remoteJid: 'jid' },
      message: {
        editedMessage: { message: { conversation: 'foo' } },
      },
    } as never);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('routeMessageUpdate — revoke, no side-effect', () => {
  it('audits mensagem_revoked when revoke target had no side-effect', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({ id: 'm-orig', conteudo: 'qq texto' });
    auditLogQueryMock.mockResolvedValueOnce([]);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-revoke-msg', remoteJid: 'jid' },
      message: {
        protocolMessage: {
          type: 0,
          key: { id: 'WAID-target', remoteJid: 'jid' },
        },
      },
    } as never);
    const rev = auditMock.mock.calls.filter((c) => c[0].acao === 'mensagem_revoked');
    expect(rev).toHaveLength(1);
  });
});

describe('routeMessageUpdate — irrelevant updates', () => {
  it('ignores updates without editedMessage or protocolMessage (e.g., read receipts)', async () => {
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-x', remoteJid: 'jid' },
      message: { reactionMessage: { text: '👍' } },
    } as never);
    expect(findByWhatsappIdMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
