/**
 * Review PR #496 (crítico 1) — as sessões de linha ADICIONAIS registram os
 * mesmos listeners de ingresso da primária:
 *   - `messages.upsert` com o lineCtx da PRÓPRIA linha (exact-match);
 *   - `messages.update` (edits/revokes) via handler compartilhado, escopado
 *     pelo canal DESTA sessão — antes do fix as linhas adicionais
 *     silenciavam edits/revokes por completo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fakeSocketFactory, handlerState, handleMessagesUpdateMock, ingressMock, managerMock } =
  vi.hoisted(() => {
    const state: { handlers: Map<string, (...args: never[]) => unknown> } = {
      handlers: new Map(),
    };
    return {
      handlerState: state,
      handleMessagesUpdateMock: vi.fn(async () => undefined),
      ingressMock: vi.fn(async () => 'handled' as const),
      managerMock: {
        register: vi.fn(),
        markState: vi.fn(),
        isEnabled: vi.fn(() => true),
      },
      fakeSocketFactory: () => ({
        ev: {
          on: (event: string, handler: (...args: never[]) => unknown) => {
            state.handlers.set(event, handler);
          },
        },
        end: vi.fn(),
        user: { id: '5511900002222:1@s.whatsapp.net' },
      }),
    };
  });

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocketFactory(),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});
vi.mock('../../../src/config/env.js', () => ({
  config: { MAIA_MULTI_LINE: true, BAILEYS_AUTH_DIR: '/tmp/maia-line-sessions-test' },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { listActiveWhatsappLinesCrossTenant: vi.fn(async () => []) },
}));
// #518 — ver nota em line-sessions-shutdown.spec.ts.
vi.mock('../../../src/db/repositories/channel-line-state-repos.js', () => ({
  // #513 — a sessão só abre depois de ADQUIRIR a posse da linha. Aqui a
  // aquisição sempre concede; a exclusividade tem suíte própria.
  channelLineStateRepo: {
    upsertTransition: vi.fn(async () => undefined),
    acquireSessionLease: vi.fn(async () => ({
      ok: true as const,
      takeover: false,
      grant: {
        channel_id: 'c',
        fencing_token: 1,
        acquired_at: new Date(),
        previous_owner: null,
      },
    })),
  },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  ingressUpsertMessage: ingressMock,
  handleMessagesUpdate: handleMessagesUpdateMock,
  getCurrentLineE164: vi.fn(() => '+5511900001111'),
  sendOutboundTextVia: vi.fn(),
  sendOutboundDocumentVia: vi.fn(),
  sendOutboundVoiceVia: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({
  markReadVia: vi.fn(),
  startTypingVia: vi.fn(),
  sendReactionVia: vi.fn(),
  sendPollVia: vi.fn(),
}));
vi.mock('../../../src/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => managerMock,
  lineAuthDir: (id: string) => `/tmp/maia-line-sessions-test/lines/${id}`,
}));

import { _internal } from '../../../src/gateway/line-sessions.js';

const CHANNEL = {
  id: 'channel-line-2-uuid',
  tenant_id: 'tenant-b',
  agent_id: 'agent-b',
  external_id: '+5511900002222',
};

beforeEach(() => {
  vi.clearAllMocks();
  handlerState.handlers.clear();
  _internal.sessions.clear();
});

describe('startLineSession — listeners de ingresso da linha adicional', () => {
  it('registra messages.update com o handler compartilhado escopado pelo canal DESTA sessão', async () => {
    await _internal.startLineSession(CHANNEL);
    const updateHandler = handlerState.handlers.get('messages.update');
    expect(updateHandler).toBeDefined();

    const updates = [{ key: { id: 'WID-EDIT' }, update: { message: {} } }];
    (updateHandler as (u: unknown) => void)(updates as never);
    // flush da microtask do void-handler
    await new Promise((r) => setImmediate(r));

    expect(handleMessagesUpdateMock).toHaveBeenCalledWith(updates, CHANNEL.id);
  });

  it('registra messages.upsert entregando pela pipeline com a linha DESTA sessão', async () => {
    await _internal.startLineSession(CHANNEL);
    const upsertHandler = handlerState.handlers.get('messages.upsert');
    expect(upsertHandler).toBeDefined();

    const msg = { key: { id: 'WID-IN' } };
    await (upsertHandler as (a: unknown) => Promise<void>)({ messages: [msg] } as never);

    expect(ingressMock).toHaveBeenCalledTimes(1);
    const [delivered, lineCtx] = ingressMock.mock.calls[0]! as [unknown, { botLineE164: string }];
    expect(delivered).toBe(msg);
    expect(lineCtx.botLineE164).toBe('+5511900002222');
  });
});
