/**
 * Review #498 (crítico 1) — em `MAIA_MULTI_LINE`, `messages.update` sem canal
 * resolvido (registro da sessão primária pendente ou permanentemente falho)
 * NÃO cai no lookup global cross-tenant: o lote é descartado fail-closed e
 * auditado (`message_update_channel_unresolved`). Com canal resolvido, o
 * fluxo escopado segue normal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock, routeMessageUpdateMock, findByWhatsappIdCrossTenantMock } = vi.hoisted(() => ({
  auditMock: vi.fn(async () => undefined),
  routeMessageUpdateMock: vi.fn(async () => undefined),
  findByWhatsappIdCrossTenantMock: vi.fn(async () => null as unknown),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
  downloadMediaMessage: vi.fn(),
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));
vi.mock('../../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-multiline-update-test',
    FEATURE_MESSAGE_UPDATE: true,
    MAIA_MULTI_LINE: true,
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappIdCrossTenant: findByWhatsappIdCrossTenantMock },
  channelsRepo: {},
}));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { findByExternalCrossTenant: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/agent/message-update.js', () => ({
  routeMessageUpdate: routeMessageUpdateMock,
}));
vi.mock('../../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/dedup.js', () => ({ isDuplicate: vi.fn(), markSeen: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn() }));
vi.mock('../../../src/gateway/debouncer.js', () => ({ scheduleDebouncedAgent: vi.fn() }));
vi.mock('../../../src/gateway/bot-detection.js', () => ({ checkBotAndMaybeBlock: vi.fn() }));
vi.mock('../../../src/setup/state.js', () => ({
  setupState: {
    current: () => ({ phase: 'connected' }),
    setQr: vi.fn(),
    markPaired: vi.fn(),
    markDisconnected: vi.fn(),
  },
}));
vi.mock('../../../src/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), existsSync: () => true, writeFileSync: vi.fn() };
});

import { handleMessagesUpdate } from '../../../src/gateway/baileys.js';

const EDIT_UPDATE = {
  key: { remoteJid: 'jid', id: 'WAID-ML-1' },
  update: { message: { editedMessage: { message: { conversation: 'edit' } } } },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  findByWhatsappIdCrossTenantMock.mockResolvedValue(null);
});

describe('handleMessagesUpdate em MAIA_MULTI_LINE (review #498 crítico 1)', () => {
  it('canal null: descarta o lote fail-closed, audita e NUNCA faz lookup global', async () => {
    await handleMessagesUpdate([EDIT_UPDATE], null);

    expect(findByWhatsappIdCrossTenantMock).not.toHaveBeenCalled();
    expect(routeMessageUpdateMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'message_update_channel_unresolved',
        metadata: expect.objectContaining({ dropped_updates: 1 }),
      }),
    );
  });

  it('canal resolvido: o fluxo escopado segue — lookup com o canal e dispatch no ALS do dono', async () => {
    findByWhatsappIdCrossTenantMock.mockResolvedValueOnce({
      id: 'orig-uuid',
      tenant_id: 'tenant-x',
      agent_id: 'agent-x',
      metadata: { whatsapp_id: 'WAID-ML-1' },
    });

    await handleMessagesUpdate([EDIT_UPDATE], 'channel-line-x');

    expect(findByWhatsappIdCrossTenantMock).toHaveBeenCalledWith('WAID-ML-1', 'channel-line-x');
    expect(routeMessageUpdateMock).toHaveBeenCalledWith(expect.anything(), 'channel-line-x');
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'message_update_channel_unresolved' }),
    );
  });
});
