import { describe, it, expect, vi, beforeEach } from 'vitest';

// #316: send_proactive_message no longer fires the WhatsApp send inline. It
// PLANS the effect (returned + extracted into the transactional outbox, atomic
// with winning the idempotency reservation) and the single relayer dispatches
// it exactly once. These tests assert the handler persists the outbound row
// with whatsapp_id=null + pending_relay=true and returns the plan projection,
// and that `extractEffect` produces the correct PlannedEffect — and crucially
// that NO inline gateway send happens.

const pessoasFindById = vi.fn();
const conversasFindActive = vi.fn();
const conversasCreate = vi.fn();
const mensagensCreate = vi.fn();
const sendOutboundTextMock = vi.fn();
// Fase 0 do roteamento multi-linha (spec 2026-07-09 §1.6): conversa NOVA nasce
// COM canal quando o agente tem canal único ativo (`{ kind: 'one', id }`);
// ambíguo/zero fica NULL (legado).
const channelsFindSoleActive = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindById },
  conversasRepo: { findActive: conversasFindActive, create: conversasCreate },
  mensagensRepo: { create: mensagensCreate },
  channelsRepo: { findSoleActiveForCurrentAgent: channelsFindSoleActive },
}));

// The gateway is mocked so we can ASSERT it is never called from the handler
// (the relayer is the only caller now).
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
  channelsFindSoleActive.mockReset();
  channelsFindSoleActive.mockResolvedValue({ kind: 'one', id: 'ch-1' });
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

describe('send_proactive_message tool (#316 transactional outbox)', () => {
  it('happy path: persists outbound mensagem (pending relay) and returns the plan WITHOUT an inline send', async () => {
    pessoasFindById.mockResolvedValueOnce({
      id: TARGET_ID,
      telefone_whatsapp: '+5511999990000',
    });
    conversasFindActive.mockResolvedValueOnce({ id: 'conv-existing', channel_id: 'ch-existing' });
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
    // whatsapp_id is null (deferred to relayer); jid + texto carried for the plan.
    expect(result).toEqual({
      mensagem_id: 'msg-uuid-1',
      whatsapp_id: null,
      jid: '5511999990000@s.whatsapp.net',
      texto: 'Lembrete: revisar fechamento.',
    });
    // CRITICAL (#316): the handler does NOT fire the gateway send.
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(conversasCreate).not.toHaveBeenCalled(); // active conversa already existed
    // Fase 0 (§1.6): conversa já existente ⇒ nenhuma resolução de canal único.
    expect(channelsFindSoleActive).not.toHaveBeenCalled();
    const m = mensagensCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(m.conversa_id).toBe('conv-existing');
    // O canal da conversa existente propaga para a mensagem persistida.
    expect(m.channel_id).toBe('ch-existing');
    expect(m.direcao).toBe('out');
    expect(m.tipo).toBe('texto');
    expect(m.conteudo).toBe('Lembrete: revisar fechamento.');
    // whatsapp_id stays null until the relayer fills provider_ref; pending_relay
    // flags the row so observability can distinguish queued from delivered.
    expect(m.metadata).toMatchObject({
      whatsapp_id: null,
      proactive: true,
      reason: 'follow_up_balancete',
      pending_relay: true,
    });
  });

  it('extractEffect projects the result into a whatsapp_text PlannedEffect', async () => {
    const { sendProactiveMessageTool } = await import(
      '../../../src/tools/send-proactive-message.js'
    );
    const effect = sendProactiveMessageTool.extractEffect!({
      mensagem_id: 'msg-uuid-1',
      whatsapp_id: null,
      jid: '5511999990000@s.whatsapp.net',
      texto: 'Lembrete: revisar fechamento.',
    } as never);
    expect(effect).toEqual({
      kind: 'whatsapp_text',
      jid: '5511999990000@s.whatsapp.net',
      text: 'Lembrete: revisar fechamento.',
      mensagem_id: 'msg-uuid-1',
    });
  });

  it('creates a new conversa when target has no active one', async () => {
    pessoasFindById.mockResolvedValueOnce({
      id: TARGET_ID,
      telefone_whatsapp: '+5511888887777',
    });
    conversasFindActive.mockResolvedValueOnce(null);
    conversasCreate.mockResolvedValueOnce({ id: 'conv-new', channel_id: 'ch-1' });
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
    // Fase 0 (§1.6): a conversa nova nasce COM o canal único ativo do agente.
    expect(channelsFindSoleActive).toHaveBeenCalledTimes(1);
    expect(conversasCreate).toHaveBeenCalledWith({
      pessoa_id: TARGET_ID,
      escopo_entidades: [],
      channel_id: 'ch-1',
    });
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    const m = mensagensCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(m.conversa_id).toBe('conv-new');
    // O canal da conversa propaga para a mensagem persistida.
    expect(m.channel_id).toBe('ch-1');
  });

  it('creates a new conversa with channel_id NULL when the agent has no sole active channel (legacy)', async () => {
    pessoasFindById.mockResolvedValueOnce({
      id: TARGET_ID,
      telefone_whatsapp: '+5511888887777',
    });
    conversasFindActive.mockResolvedValueOnce(null);
    channelsFindSoleActive.mockResolvedValueOnce({ kind: 'none' });
    conversasCreate.mockResolvedValueOnce({ id: 'conv-new-legacy', channel_id: null });
    mensagensCreate.mockResolvedValueOnce({ id: 'msg-uuid-3' });

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
    // Sem canal único resolvível ⇒ comportamento legado: conversa sem canal
    // (o envio físico no relayer falha fechado por conta própria nesse caso).
    expect(conversasCreate).toHaveBeenCalledWith({
      pessoa_id: TARGET_ID,
      escopo_entidades: [],
      channel_id: null,
    });
    const m = mensagensCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(m.channel_id).toBeNull();
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

  it('throws pessoa_destino_not_found when target does not exist (no send, no persist)', async () => {
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
