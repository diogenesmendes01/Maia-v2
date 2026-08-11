/**
 * Fase 0 do roteamento multi-linha (spec 2026-07-09 Draft v4 §1.6/§5) —
 * fronteira única de saída:
 *   - `forChannel` RECUSA triplete inconsistente (canal de outro tenant/agent
 *     ou inativo) — fail-closed, nada é enviado;
 *   - `forCurrentAgentChannel(null)` resolve o canal ÚNICO ativo e falha
 *     fechado em zero/ambíguo;
 *   - classificação fase 0: com o manager DESLIGADO, os sends delegam nas
 *     primitivas globais (paridade byte-a-byte); LIGADO, delegam na sessão da
 *     linha e NUNCA caem para outra linha quando a sessão não existe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  channelBelongsToScopeActive,
  findSoleActiveForCurrentAgent,
  sendOutboundText,
  sendOutboundDocument,
  sendOutboundVoice,
  isBaileysConnected,
  presenceSendPoll,
  presenceSendReaction,
  presenceStartTyping,
  presenceMarkRead,
  manager,
} = vi.hoisted(() => ({
  channelBelongsToScopeActive: vi.fn(),
  findSoleActiveForCurrentAgent: vi.fn(),
  sendOutboundText: vi.fn(async () => 'wid-global'),
  sendOutboundDocument: vi.fn(async () => 'wid-doc'),
  sendOutboundVoice: vi.fn(async () => 'wid-voice'),
  isBaileysConnected: vi.fn(() => true),
  presenceSendPoll: vi.fn(async () => ({
    whatsapp_id: 'wid-poll',
    message_secret: 's',
    creator_jid: 'c@s.whatsapp.net',
  })),
  presenceSendReaction: vi.fn(),
  presenceStartTyping: vi.fn(() => ({ stop: vi.fn() })),
  presenceMarkRead: vi.fn(),
  manager: {
    isEnabled: vi.fn(() => false),
    transportFor: vi.fn(),
    isLineConnected: vi.fn(() => true),
  },
}));

vi.mock('../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { channelBelongsToScopeActive, findSoleActiveForCurrentAgent },
}));

vi.mock('../../src/db/tenant-context.js', () => ({
  getCurrentTenant: () => 't1',
  getCurrentAgent: () => 'a1',
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText,
  sendOutboundDocument,
  sendOutboundVoice,
  isBaileysConnected,
}));

vi.mock('../../src/gateway/presence.js', () => ({
  sendPoll: presenceSendPoll,
  sendReaction: presenceSendReaction,
  startTyping: presenceStartTyping,
  markRead: presenceMarkRead,
}));

vi.mock('../../src/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => manager,
}));

import {
  forChannel,
  forCurrentAgentChannel,
  _clearScopeCacheForTests,
} from '../../src/gateway/line-output.js';

const SCOPE = { tenant_id: 't1', agent_id: 'a1', channel_id: 'ch-1' };

beforeEach(() => {
  vi.clearAllMocks();
  manager.isEnabled.mockReturnValue(false);
  _clearScopeCacheForTests();
});

describe('forChannel — validação do triplete (fail-closed)', () => {
  it('recusa canal que não pertence ao (tenant, agent) — nada é enviado', async () => {
    channelBelongsToScopeActive.mockResolvedValue(false);
    await expect(forChannel(SCOPE)).rejects.toMatchObject({
      code: 'channel_scope_mismatch',
    });
    expect(sendOutboundText).not.toHaveBeenCalled();
  });

  it('aceita triplete válido e devolve LineOutput com o MESMO escopo', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    const line = await forChannel(SCOPE);
    expect(line.scope).toEqual(SCOPE);
  });

  it('cacheia a validação por 60s (uma leitura por triplete no caminho quente)', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    await forChannel(SCOPE);
    await forChannel(SCOPE);
    expect(channelBelongsToScopeActive).toHaveBeenCalledTimes(1);
  });

  it('NÃO cacheia recusa — um mismatch é revalidado a cada tentativa', async () => {
    channelBelongsToScopeActive.mockResolvedValue(false);
    await expect(forChannel(SCOPE)).rejects.toBeTruthy();
    await expect(forChannel(SCOPE)).rejects.toBeTruthy();
    expect(channelBelongsToScopeActive).toHaveBeenCalledTimes(2);
  });
});

describe('forCurrentAgentChannel — resolução do canal único (legado/proativo)', () => {
  it('channel_id explícito valida o triplete do ALS', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    const line = await forCurrentAgentChannel('ch-1');
    expect(channelBelongsToScopeActive).toHaveBeenCalledWith(SCOPE);
    expect(line.scope.channel_id).toBe('ch-1');
  });

  it('NULL resolve o canal ÚNICO ativo do agente', async () => {
    findSoleActiveForCurrentAgent.mockResolvedValue({ kind: 'one', id: 'ch-9' });
    const line = await forCurrentAgentChannel(null);
    expect(line.scope).toEqual({ tenant_id: 't1', agent_id: 'a1', channel_id: 'ch-9' });
  });

  it('zero canais ativos ⇒ channel_ambiguous (fail-closed)', async () => {
    findSoleActiveForCurrentAgent.mockResolvedValue({ kind: 'none' });
    await expect(forCurrentAgentChannel(null)).rejects.toMatchObject({
      code: 'channel_ambiguous',
    });
  });

  it('2+ canais ativos ⇒ channel_ambiguous — NUNCA escolhe um "primário"', async () => {
    findSoleActiveForCurrentAgent.mockResolvedValue({ kind: 'many' });
    await expect(forCurrentAgentChannel(null)).rejects.toMatchObject({
      code: 'channel_ambiguous',
    });
    expect(sendOutboundText).not.toHaveBeenCalled();
  });
});

describe('fase 0 — classificação de transporte inalterada', () => {
  it('manager DESLIGADO: sends delegam nas primitivas globais (paridade)', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    const line = await forChannel(SCOPE);
    await line.sendText('jid', 'oi', { view_once: true });
    expect(sendOutboundText).toHaveBeenCalledWith('jid', 'oi', { view_once: true });
    await line.sendPoll('jid', 'q', [{ key: 'a', label: 'A' }]);
    expect(presenceSendPoll).toHaveBeenCalled();
    line.markRead('jid', 'wid');
    expect(presenceMarkRead).toHaveBeenCalledWith('jid', 'wid');
    expect(line.isConnected()).toBe(true);
    expect(manager.transportFor).not.toHaveBeenCalled();
  });

  it('manager LIGADO: send sai pela sessão DA LINHA, não pela global', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    manager.isEnabled.mockReturnValue(true);
    const transport = { sendText: vi.fn(async () => 'wid-line') };
    manager.transportFor.mockReturnValue(transport);
    const line = await forChannel(SCOPE);
    await expect(line.sendText('jid', 'oi')).resolves.toBe('wid-line');
    expect(transport.sendText).toHaveBeenCalledWith('jid', 'oi', undefined);
    expect(sendOutboundText).not.toHaveBeenCalled();
  });

  it('manager LIGADO sem sessão viva: falha fechado — NUNCA sai por outra linha', async () => {
    channelBelongsToScopeActive.mockResolvedValue(true);
    manager.isEnabled.mockReturnValue(true);
    manager.transportFor.mockImplementation(() => {
      throw Object.assign(new Error('no live session'), {
        code: 'line_session_unavailable',
      });
    });
    const line = await forChannel(SCOPE);
    await expect(line.sendText('jid', 'oi')).rejects.toMatchObject({
      code: 'line_session_unavailable',
    });
    expect(sendOutboundText).not.toHaveBeenCalled();
  });
});
