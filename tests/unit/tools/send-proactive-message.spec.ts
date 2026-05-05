import { describe, it, expect, vi, beforeEach } from 'vitest';

const pessoasFindById = vi.fn();
const conversasFindActive = vi.fn();
const conversasCreate = vi.fn();
const mensagensCreate = vi.fn();
const sendOutboundTextMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindById },
  conversasRepo: { findActive: conversasFindActive, create: conversasCreate },
  mensagensRepo: { create: mensagensCreate },
}));

vi.mock('../../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
}));

vi.mock('../../../src/governance/permissions.js', () => ({
  isOwnerType: vi.fn(() => false),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  pessoasFindById.mockReset();
  conversasFindActive.mockReset();
  conversasCreate.mockReset();
  mensagensCreate.mockReset();
  sendOutboundTextMock.mockReset();
});

const TARGET_ID = '44444444-4444-4444-4444-444444444444';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('send_proactive_message tool', () => {
  it('happy path: sends WhatsApp text and persists outbound mensagem', async () => {
    pessoasFindById.mockResolvedValueOnce({
      id: TARGET_ID,
      telefone_whatsapp: '+5511999990000',
    });
    sendOutboundTextMock.mockResolvedValueOnce('wa-id-xyz');
    conversasFindActive.mockResolvedValueOnce({ id: 'conv-existing' });
    mensagensCreate.mockResolvedValueOnce({ id: 'msg-uuid-1' });

    const { sendProactiveMessageTool } = await import(
      '../../../src/tools/send-proactive-message.js'
    );
    const result = await sendProactiveMessageTool.handler(
      {
        pessoa_id_destino: TARGET_ID,
        texto: 'Lembrete: revisar fechamento.',
        reason: 'follow_up_balancete',
      } as never,
      ctx,
    );
    expect(result).toEqual({ mensagem_id: 'msg-uuid-1', whatsapp_id: 'wa-id-xyz' });
    // JID must strip the leading '+' and append '@s.whatsapp.net'.
    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511999990000@s.whatsapp.net',
      'Lembrete: revisar fechamento.',
    );
    expect(conversasCreate).not.toHaveBeenCalled(); // active conversa already existed
    const m = mensagensCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(m.conversa_id).toBe('conv-existing');
    expect(m.direcao).toBe('out');
    expect(m.tipo).toBe('texto');
    expect(m.conteudo).toBe('Lembrete: revisar fechamento.');
    expect(m.metadata).toMatchObject({
      whatsapp_id: 'wa-id-xyz',
      proactive: true,
      reason: 'follow_up_balancete',
    });
  });

  it('creates a new conversa when target has no active one', async () => {
    pessoasFindById.mockResolvedValueOnce({
      id: TARGET_ID,
      telefone_whatsapp: '+5511888887777',
    });
    sendOutboundTextMock.mockResolvedValueOnce('wa-id-2');
    conversasFindActive.mockResolvedValueOnce(null);
    conversasCreate.mockResolvedValueOnce({ id: 'conv-new' });
    mensagensCreate.mockResolvedValueOnce({ id: 'msg-uuid-2' });

    const { sendProactiveMessageTool } = await import(
      '../../../src/tools/send-proactive-message.js'
    );
    await sendProactiveMessageTool.handler(
      {
        pessoa_id_destino: TARGET_ID,
        texto: 'Olá',
        reason: 'first_contact',
      } as never,
      ctx,
    );
    expect(conversasCreate).toHaveBeenCalledWith({
      pessoa_id: TARGET_ID,
      escopo_entidades: [],
    });
    const m = mensagensCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(m.conversa_id).toBe('conv-new');
  });

  it('schema invalid: rejects empty texto', async () => {
    const { sendProactiveMessageTool } = await import(
      '../../../src/tools/send-proactive-message.js'
    );
    const parsed = sendProactiveMessageTool.input_schema.safeParse({
      pessoa_id_destino: TARGET_ID,
      texto: '',
      reason: 'whatever',
    });
    expect(parsed.success).toBe(false);
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
  });

  it('throws pessoa_destino_not_found when target does not exist (no WhatsApp send)', async () => {
    pessoasFindById.mockResolvedValueOnce(null);
    const { sendProactiveMessageTool } = await import(
      '../../../src/tools/send-proactive-message.js'
    );
    await expect(
      sendProactiveMessageTool.handler(
        {
          pessoa_id_destino: TARGET_ID,
          texto: 'qualquer',
          reason: 'follow_up',
        } as never,
        ctx,
      ),
    ).rejects.toThrow('pessoa_destino_not_found');
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(mensagensCreate).not.toHaveBeenCalled();
  });
});
