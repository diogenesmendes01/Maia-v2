/**
 * Auditoria P0 cap. 7 — loggedOut de uma linha ADICIONAL encerra a posse DE
 * VERDADE, não só em memória:
 *  - audita `pairing_logged_out` sob o ALS do (tenant, agent) dono do canal
 *    (mesmo evento da primária, com o canal em metadata);
 *  - delega ao recovery POR ALVO ({ target: 'line', channel }) que desativa
 *    o canal no DB e remove APENAS lines/<channel_id>;
 *  - nenhuma reconexão é agendada (a posse acabou — precisa re-parear §2.5).
 * Antes do fix, o close apenas marcava a sessão `closed` em memória e a row
 * do canal podia continuar ativa/elegível para o roteamento.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { makeSocketMock, handlerState, auditMock, auditContexts, managerMock, triggerRecoveryMock } =
  vi.hoisted(() => {
    const state: {
      sockets: Array<{ handlers: Map<string, (...args: never[]) => unknown>; end: () => void }>;
    } = { sockets: [] };
    return {
      handlerState: state,
      auditMock: vi.fn(async () => undefined),
      auditContexts: [] as Array<{ tenant_id: string; agent_id: string } | null>,
      triggerRecoveryMock: vi.fn(async () => undefined),
      managerMock: {
        register: vi.fn(),
        markState: vi.fn(),
        isEnabled: vi.fn(() => true),
      },
      makeSocketMock: vi.fn(() => {
        const sock = {
          ev: {
            on: (event: string, handler: (...args: never[]) => unknown) => {
              state.sockets[state.sockets.length - 1]!.handlers.set(event, handler);
            },
          },
          end: vi.fn(),
          user: { id: '5511900002222:1@s.whatsapp.net' },
        };
        state.sockets.push({ handlers: new Map(), end: sock.end });
        return sock;
      }),
    };
  });

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeSocketMock,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});
vi.mock('../../../src/config/env.js', () => ({
  config: { MAIA_MULTI_LINE: true, BAILEYS_AUTH_DIR: '/tmp/maia-baileys-line-loggedout-test' },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { listActiveWhatsappLinesCrossTenant: vi.fn(async () => []) },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  ingressUpsertMessage: vi.fn(async () => 'handled' as const),
  handleMessagesUpdate: vi.fn(async () => undefined),
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
  lineAuthDir: (id: string) => `/tmp/maia-baileys-line-loggedout-test/lines/${id}`,
}));
vi.mock('../../../src/setup/recovery.js', () => ({ triggerRecovery: triggerRecoveryMock }));

import { _internal } from '../../../src/gateway/line-sessions.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL = {
  id: 'channel-line-2-uuid',
  tenant_id: 'tenant-b',
  agent_id: 'agent-b',
  external_id: '+5511900002222',
};

function fireConnectionUpdate(socketIdx: number, update: unknown): void {
  const handler = handlerState.sockets[socketIdx]!.handlers.get('connection.update');
  expect(handler).toBeDefined();
  (handler as (u: unknown) => void)(update);
}

const CLOSE_LOGGED_OUT = {
  connection: 'close',
  lastDisconnect: { error: { output: { statusCode: 401 } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  handlerState.sockets.length = 0;
  auditContexts.length = 0;
  auditMock.mockImplementation(async () => {
    auditContexts.push(tryGetCurrentContext());
  });
  _internal.sessions.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loggedOut de linha adicional — posse encerrada de verdade (cap. 7)', () => {
  it('audita pairing_logged_out sob ALS do dono e delega ao recovery por-alvo', async () => {
    await _internal.startLineSession(CHANNEL);
    fireConnectionUpdate(0, CLOSE_LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(0);

    // Auditoria com o canal em metadata, sob o ALS do dono (review #498 alto 2).
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'pairing_logged_out',
      metadata: {
        channel_id: CHANNEL.id,
        line_external_id: CHANNEL.external_id,
        is_primary: false,
        reason: 401,
      },
    });
    const loggedOutIdx = auditMock.mock.calls.findIndex(
      (c) => (c[0] as { acao: string }).acao === 'pairing_logged_out',
    );
    expect(auditContexts[loggedOutIdx]).toMatchObject({
      tenant_id: 'tenant-b',
      agent_id: 'agent-b',
    });

    // Recovery POR ALVO com o triplete completo do canal.
    expect(triggerRecoveryMock).toHaveBeenCalledTimes(1);
    expect(triggerRecoveryMock).toHaveBeenCalledWith({ target: 'line', channel: CHANNEL });

    // Sessão marcada closed no manager (fail-closed no transporte).
    expect(managerMock.markState).toHaveBeenCalledWith(CHANNEL.id, 'closed');
  });

  it('NÃO agenda reconexão após loggedOut (posse encerrada — precisa re-parear)', async () => {
    await _internal.startLineSession(CHANNEL);
    expect(makeSocketMock).toHaveBeenCalledTimes(1);

    fireConnectionUpdate(0, CLOSE_LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(makeSocketMock).toHaveBeenCalledTimes(1); // nenhuma reabertura
  });

  it('close transiente (≠ loggedOut) NÃO dispara o recovery da linha', async () => {
    await _internal.startLineSession(CHANNEL);
    fireConnectionUpdate(0, {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(triggerRecoveryMock).not.toHaveBeenCalled();
    const acaos = auditMock.mock.calls.map((c) => (c[0] as { acao: string }).acao);
    expect(acaos).not.toContain('pairing_logged_out');
  });
});
