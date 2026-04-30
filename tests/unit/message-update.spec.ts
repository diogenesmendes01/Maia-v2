import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappIdMock = vi.fn();
const auditLogQueryMock = vi.fn();
const findOwnerByPhoneMock = vi.fn();
const findActiveConversaMock = vi.fn();
const pendingCreateTxMock = vi.fn();
const pendingCancelOpenForConversaTxMock = vi.fn();
const mensagensCreateMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: {
    findByWhatsappId: findByWhatsappIdMock,
    create: mensagensCreateMock,
  },
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

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID-OWNER-NOTIFY');
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
}));

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
  mensagensCreateMock.mockReset();
  mensagensCreateMock.mockResolvedValue({ id: 'm-out-stub' });
  auditMock.mockReset();
  withTxMock.mockClear();
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('WAID-OWNER-NOTIFY');
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

describe('routeMessageUpdate — side-effect detected', () => {
  it('creates edit_review pending in OWNER conversa, includes entidade_id in acao_proposta, and audits both pending_substituted_by_edit_review and mensagem_edited_after_side_effect', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50 mercado',
      conversa_id: 'c-user',
    });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-1', entidade_alvo: 'e-1', mensagem_id: 'm-orig' },
    ]);
    findOwnerByPhoneMock.mockResolvedValueOnce({
      id: 'owner-id',
      telefone_whatsapp: '+5511999999999',
    });
    findActiveConversaMock.mockResolvedValueOnce({ id: 'c-owner', pessoa_id: 'owner-id' });
    pendingCancelOpenForConversaTxMock.mockResolvedValueOnce({ cancelled_ids: ['pq-old'] });
    pendingCreateTxMock.mockResolvedValueOnce({ id: 'pq-edit-review' });

    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'lança 50 restaurante' } } },
    } as never);

    expect(pendingCreateTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversa_id: 'c-owner',
        pessoa_id: 'owner-id',
        tipo: 'edit_review',
        acao_proposta: {
          tool: 'cancel_transaction',
          args: expect.objectContaining({
            transacao_id: 'tx-1',
            entidade_id: 'e-1',
            motivo: 'edit_review',
          }),
        },
      }),
    );
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'mensagem_edited_after_side_effect')).toBe(true);
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'pending_substituted_by_edit_review')).toBe(true);
  });

  it('skips pending creation when owner is not configured', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({ id: 'm-orig', conteudo: 'x', conversa_id: 'c1' });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-1', entidade_alvo: 'e-1' },
    ]);
    findOwnerByPhoneMock.mockResolvedValueOnce(null);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'y' } } },
    } as never);
    expect(pendingCreateTxMock).not.toHaveBeenCalled();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'mensagem_edited_after_side_effect')).toBe(true);
  });

  it('skips pending creation when audit row lacks entidade_alvo (e.g. legacy audit pre-fix)', async () => {
    // If a `transaction_created` audit was written before the dispatcher
    // started carrying `entidade_alvo`/`alvo_id`, we cannot route the cancel
    // safely. Better to skip silently than to fall back to the wrong entity.
    findByWhatsappIdMock.mockResolvedValueOnce({ id: 'm-orig', conteudo: 'x', conversa_id: 'c1' });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-1', entidade_alvo: null },
    ]);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'y' } } },
    } as never);
    expect(pendingCreateTxMock).not.toHaveBeenCalled();
    expect(findOwnerByPhoneMock).not.toHaveBeenCalled();
  });

  it('revoke side-effect path also creates edit_review pending', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({ id: 'm-orig', conteudo: 'x', conversa_id: 'c-user' });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-2', entidade_alvo: 'e-2' },
    ]);
    findOwnerByPhoneMock.mockResolvedValueOnce({
      id: 'owner-id',
      telefone_whatsapp: '+5511999999999',
    });
    findActiveConversaMock.mockResolvedValueOnce({ id: 'c-owner', pessoa_id: 'owner-id' });
    pendingCreateTxMock.mockResolvedValueOnce({ id: 'pq-edit-review-rev' });

    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-rev', remoteJid: 'jid' },
      message: { protocolMessage: { type: 0, key: { id: 'WAID-target', remoteJid: 'jid' } } },
    } as never);

    expect(pendingCreateTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tipo: 'edit_review',
        acao_proposta: expect.objectContaining({
          tool: 'cancel_transaction',
          args: expect.objectContaining({
            transacao_id: 'tx-2',
            entidade_id: 'e-2',
            motivo: 'revoke_review',
          }),
        }),
      }),
    );
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'mensagem_revoked_after_side_effect')).toBe(true);
  });

  it('notifies owner via outbound WhatsApp message after creating edit_review pending', async () => {
    // Without this notification the pending sits silently in the DB and the
    // owner has no idea they should reply sim/não — see the PR #16 review
    // bloqueador on src/agent/message-update.ts:168.
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50 mercado',
      conversa_id: 'c-user',
    });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-99', entidade_alvo: 'e-99' },
    ]);
    findOwnerByPhoneMock.mockResolvedValueOnce({
      id: 'owner-id',
      telefone_whatsapp: '+5511999999999',
    });
    findActiveConversaMock.mockResolvedValueOnce({ id: 'c-owner', pessoa_id: 'owner-id' });
    pendingCreateTxMock.mockResolvedValueOnce({ id: 'pq-99' });

    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await routeMessageUpdate({
      key: { id: 'WAID-1', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'novo' } } },
    } as never);

    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      expect.stringContaining('virou transação'),
    );
    expect(mensagensCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversa_id: 'c-owner',
        direcao: 'out',
        metadata: expect.objectContaining({
          pending_question_id: 'pq-99',
          remote_jid: '5511999999999@s.whatsapp.net',
          source: 'edit_review',
        }),
      }),
    );
  });

  it('owner notification failure does not block pending creation', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce({
      id: 'm-orig',
      conteudo: 'lança 50',
      conversa_id: 'c-user',
    });
    auditLogQueryMock.mockResolvedValueOnce([
      { acao: 'transaction_created', alvo_id: 'tx-1', entidade_alvo: 'e-1' },
    ]);
    findOwnerByPhoneMock.mockResolvedValueOnce({
      id: 'owner-id',
      telefone_whatsapp: '+5511999999999',
    });
    findActiveConversaMock.mockResolvedValueOnce({ id: 'c-owner', pessoa_id: 'owner-id' });
    pendingCreateTxMock.mockResolvedValueOnce({ id: 'pq-1' });
    sendOutboundTextMock.mockRejectedValueOnce(new Error('whatsapp down'));

    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    await expect(
      routeMessageUpdate({
        key: { id: 'WAID-1', remoteJid: 'jid' },
        message: { editedMessage: { message: { conversation: 'x' } } },
      } as never),
    ).resolves.toBeUndefined();
    expect(pendingCreateTxMock).toHaveBeenCalled();
    expect(mensagensCreateMock).not.toHaveBeenCalled();
  });
});

describe('routeMessageUpdate — Baileys envelope contract (v6.7.0)', () => {
  // These tests pin the exact event-shape Task 9's listener relies on. If a
  // future Baileys upgrade renames `editedMessage` or restructures
  // `update.update.message`, these break loudly so the listener gets fixed
  // before users notice silently-dropped edits.
  it('routeMessageUpdate accepts { key, message } with editedMessage shape', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce(null); // unknown original → silent return
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    const fixture = {
      key: { id: 'WAID-edit', remoteJid: 'jid' },
      message: { editedMessage: { message: { conversation: 'novo conteudo' } } },
    };
    await expect(routeMessageUpdate(fixture as never)).resolves.toBeUndefined();
  });

  it('routeMessageUpdate accepts protocolMessage type=0 for revoke', async () => {
    findByWhatsappIdMock.mockResolvedValueOnce(null);
    const { routeMessageUpdate } = await import('../../src/agent/message-update.js');
    const fixture = {
      key: { id: 'WAID-revoke', remoteJid: 'jid' },
      message: {
        protocolMessage: { type: 0, key: { id: 'WAID-target', remoteJid: 'jid' } },
      },
    };
    await expect(routeMessageUpdate(fixture as never)).resolves.toBeUndefined();
  });
});
