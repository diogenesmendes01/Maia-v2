/**
 * Review #498 (alto 3) — o timer de reconexão das sessões de linha é
 * RASTREADO e cancelado no shutdown: antes, o callback do setTimeout
 * sobrevivia a `shutdownLineSessions()`, chamava `startLineSession()` de
 * novo e reabria o socket com um estado novo (`stopped=false`) durante o
 * desligamento.
 *
 * Também cobre (alto 2): as transições de sessão auditam sob o ALS do
 * (tenant, agent) dono do canal — não mais no bucket `system`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { makeSocketMock, handlerState, auditMock, auditContexts, managerMock } = vi.hoisted(() => {
  const state: {
    sockets: Array<{ handlers: Map<string, (...args: never[]) => unknown>; end: () => void }>;
  } = { sockets: [] };
  return {
    handlerState: state,
    auditMock: vi.fn(async () => undefined),
    auditContexts: [] as Array<{ tenant_id: string; agent_id: string } | null>,
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
  config: { MAIA_MULTI_LINE: true, BAILEYS_AUTH_DIR: '/tmp/maia-line-shutdown-test' },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({
  audit: auditMock,
}));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { listActiveWhatsappLinesCrossTenant: vi.fn(async () => []) },
}));
// #518 — a transição de sessão passa a PERSISTIR o estado da linha (103).
// É best-effort e fail-isolated; aqui basta stubar para o teste não tocar o DB.
vi.mock('../../../src/gateway/channel-lease.js', () => ({
  // #513 — este spec é sobre listeners/shutdown da sessão, não sobre POSSE.
  // A posse tem cobertura própria contra Postgres real
  // (`channel-session-fence-real-db` e `channel-session-takeover-fecha-socket-real-db`);
  // aqui ela é concedida para que o caminho sob teste chegue a rodar.
  acquireChannelLease: vi.fn(async () => ({
    held: true as const,
    result: 'acquired' as const,
    scope: { tenant_id: 't', agent_id: 'a', channel_id: 'c' },
    owner_instance_id: 'teste',
    fencing_token: 1,
    lease_expires_at: new Date(Date.now() + 30_000),
  })),
  releaseChannelLease: vi.fn(async () => true),
  heartbeatChannelLease: vi.fn(async () => 'renewed' as const),
}));
vi.mock('../../../src/db/repositories/channel-line-state-repos.js', () => ({
  channelLineStateRepo: { upsertTransition: vi.fn(async () => undefined) },
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
  lineAuthDir: (id: string) => `/tmp/maia-line-shutdown-test/lines/${id}`,
}));

import { _internal, shutdownLineSessions } from '../../../src/gateway/line-sessions.js';
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

const CLOSE_TRANSIENT = {
  connection: 'close',
  lastDisconnect: { error: { output: { statusCode: 500 } } },
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

describe('shutdownLineSessions — timers de reconexão (review #498 alto 3)', () => {
  it('cancela o timer pendente: NENHUM socket reabre depois do shutdown', async () => {
    await _internal.startLineSession(CHANNEL);
    expect(makeSocketMock).toHaveBeenCalledTimes(1);

    // Close transiente (≠ loggedOut) agenda a reconexão…
    fireConnectionUpdate(0, CLOSE_TRANSIENT);

    // …mas o shutdown chega antes do timer disparar.
    await shutdownLineSessions();
    expect(_internal.sessions.size).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeSocketMock).toHaveBeenCalledTimes(1); // nenhuma reabertura
  });

  it('controle positivo: sem shutdown, o mesmo close agenda e REABRE o socket', async () => {
    await _internal.startLineSession(CHANNEL);
    fireConnectionUpdate(0, CLOSE_TRANSIENT);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeSocketMock).toHaveBeenCalledTimes(2);
  });

  it('callback re-checa stopped: shutdown DEPOIS do disparo mas com stopped marcado não reabre', async () => {
    await _internal.startLineSession(CHANNEL);
    fireConnectionUpdate(0, CLOSE_TRANSIENT);

    // Simula a janela: o estado é marcado stopped sem passar pelo clearTimeout
    // (equivale a um shutdown que correu entre o agendamento e o disparo).
    for (const state of _internal.sessions.values()) state.stopped = true;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeSocketMock).toHaveBeenCalledTimes(1);
  });
});

describe('transições auditadas sob ALS do dono do canal (review #498 alto 2)', () => {
  it('connected e close auditam com tenant/agent do canal — nunca bucket system', async () => {
    await _internal.startLineSession(CHANNEL);

    fireConnectionUpdate(0, { connection: 'open' });
    fireConnectionUpdate(0, CLOSE_TRANSIENT);
    // flush das microtasks dos void-handlers
    await vi.advanceTimersByTimeAsync(0);

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'line_session_transition' }),
    );
    expect(auditContexts.length).toBeGreaterThanOrEqual(2);
    for (const ctx of auditContexts) {
      expect(ctx).toMatchObject({ tenant_id: 'tenant-b', agent_id: 'agent-b' });
    }
  });
});
